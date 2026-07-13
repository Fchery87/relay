import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const record = mutation({
  args: {
    commit: v.string(),
    deviceToken: v.string(),
    messageId: v.id("messages"),
    ref: v.string(),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    const thread = await ctx.db.get("threads", args.threadId);
    const project = thread ? await ctx.db.get("projects", thread.projectId) : null;
    const message = await ctx.db.get("messages", args.messageId);
    if (!machine || !thread || !project || project.machineId !== machine._id || !message || message.threadId !== thread._id || message.role !== "assistant") throw new Error("Invalid checkpoint ownership");
    const expectedRef = `refs/relay/checkpoints/${args.threadId}/${args.messageId}`;
    if (args.ref !== expectedRef) throw new Error("Invalid checkpoint ref");
    const existing = await ctx.db.query("checkpoints").withIndex("by_message_id", (q) => q.eq("messageId", args.messageId)).unique();
    if (existing) return existing._id;
    return ctx.db.insert("checkpoints", { commit: args.commit, messageId: args.messageId, ref: args.ref, threadId: args.threadId });
  },
});

export const listForThread = query({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.query("checkpoints").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
});

export const enqueueComparison = mutation({
  args: { fromCheckpointId: v.id("checkpoints"), threadId: v.id("threads"), toCheckpointId: v.id("checkpoints") },
  handler: async (ctx, args) => {
    const [from, to] = await Promise.all([ctx.db.get("checkpoints", args.fromCheckpointId), ctx.db.get("checkpoints", args.toCheckpointId)]);
    if (!from || !to || from.threadId !== args.threadId || to.threadId !== args.threadId) throw new Error("Checkpoints do not belong to thread");
    return ctx.db.insert("checkpointComparisons", { fromCheckpointId: from._id, status: "queued", threadId: args.threadId, toCheckpointId: to._id });
  },
});

export const latestComparison = query({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.query("checkpointComparisons").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).order("desc").first(),
});

export const claimComparison = mutation({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    if (!machine) return null;
    const now = Date.now();
    const queued = await ctx.db.query("checkpointComparisons").withIndex("by_status", (q) => q.eq("status", "queued")).take(100);
    const running = await ctx.db.query("checkpointComparisons").withIndex("by_status", (q) => q.eq("status", "running")).take(100);
    for (const comparison of [...queued, ...running.filter((item) => (item.leaseExpiresAt ?? 0) <= now)]) {
      const [from, to, thread] = await Promise.all([ctx.db.get("checkpoints", comparison.fromCheckpointId), ctx.db.get("checkpoints", comparison.toCheckpointId), ctx.db.get("threads", comparison.threadId)]);
      const project = thread ? await ctx.db.get("projects", thread.projectId) : null;
      if (!from || !to || !thread || !project || project.machineId !== machine._id) continue;
      const claimToken = crypto.randomUUID();
      await ctx.db.patch(comparison._id, { claimToken, leaseExpiresAt: now + 30_000, status: "running" });
      return { claimToken, comparisonId: comparison._id, fromCommit: from.commit, projectPath: project.path, threadId: thread._id, toCommit: to.commit };
    }
    return null;
  },
});

export const completeComparison = mutation({
  args: { claimToken: v.string(), comparisonId: v.id("checkpointComparisons"), content: v.string(), deviceToken: v.string(), status: v.union(v.literal("complete"), v.literal("failed")) },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    const comparison = await ctx.db.get("checkpointComparisons", args.comparisonId);
    if (!comparison || comparison.status !== "running") return null;
    if (comparison.claimToken !== args.claimToken) throw new Error("Comparison lease is no longer active");
    const thread = await ctx.db.get("threads", comparison.threadId);
    const project = thread ? await ctx.db.get("projects", thread.projectId) : null;
    if (!machine || !project || project.machineId !== machine._id) throw new Error("Checkpoint comparison does not belong to this machine");
    await ctx.db.patch(comparison._id, { claimToken: undefined, content: args.content, leaseExpiresAt: undefined, status: args.status });
    return null;
  },
});

export const enqueueRestore = mutation({
  args: { checkpointId: v.id("checkpoints"), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const checkpoint = await ctx.db.get("checkpoints", args.checkpointId);
    if (!checkpoint || checkpoint.threadId !== args.threadId) throw new Error("Checkpoint does not belong to thread");
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread || thread.status === "queued" || thread.status === "running" || thread.status === "awaiting-approval" || thread.status === "restoring") throw new Error("Cannot restore a busy thread");
    const [commands, gitActions, checkpointActions] = await Promise.all([
      ctx.db.query("commands").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
      ctx.db.query("gitActions").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
      ctx.db.query("checkpointActions").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
    ]);
    if (commands.some((item) => item.status === "queued" || item.status === "running") || gitActions.some((item) => item.status === "queued" || item.status === "running") || checkpointActions.some((item) => item.status === "queued" || item.status === "running")) throw new Error("Cannot restore while another worktree action is active");
    const actionId = await ctx.db.insert("checkpointActions", { checkpointId: checkpoint._id, resumeStatus: thread.status, status: "queued", threadId: args.threadId });
    await ctx.db.patch(thread._id, { status: "restoring" });
    return actionId;
  },
});

export const claimRestore = mutation({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    if (!machine) return null;
    const now = Date.now();
    const queued = await ctx.db.query("checkpointActions").withIndex("by_status", (q) => q.eq("status", "queued")).take(100);
    const running = await ctx.db.query("checkpointActions").withIndex("by_status", (q) => q.eq("status", "running")).take(100);
    const candidates = [...queued, ...running.filter((action) => (action.leaseExpiresAt ?? 0) <= now)];
    for (const action of candidates) {
      const checkpoint = await ctx.db.get("checkpoints", action.checkpointId);
      const thread = await ctx.db.get("threads", action.threadId);
      const project = thread ? await ctx.db.get("projects", thread.projectId) : null;
      if (!checkpoint || !thread || thread.status !== "restoring" || !project || project.machineId !== machine._id) continue;
      const claimToken = crypto.randomUUID();
      await ctx.db.patch(action._id, { claimToken, leaseExpiresAt: now + 30_000, status: "running" });
      return { actionId: action._id, checkpointId: checkpoint._id, claimToken, commit: checkpoint.commit, projectPath: project.path, threadId: thread._id };
    }
    return null;
  },
});

export const completeRestore = mutation({
  args: { actionId: v.id("checkpointActions"), claimToken: v.string(), deviceToken: v.string(), status: v.union(v.literal("complete"), v.literal("failed")) },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    const action = await ctx.db.get("checkpointActions", args.actionId);
    if (!action || action.status !== "running") return null;
    if (action.claimToken !== args.claimToken) throw new Error("Restore lease is no longer active");
    const thread = await ctx.db.get("threads", action.threadId);
    const project = thread ? await ctx.db.get("projects", thread.projectId) : null;
    if (!machine || !thread || !project || project.machineId !== machine._id) throw new Error("Restore action does not belong to this machine");
    await ctx.db.patch(action._id, { claimToken: undefined, leaseExpiresAt: undefined, status: args.status });
    if (args.status === "complete") await ctx.db.insert("events", { checkpointId: action.checkpointId, kind: "checkpoint.reverted", threadId: action.threadId });
    const queuedMessage = await ctx.db.query("messages").withIndex("by_queued_thread", (q) => q.eq("queuedThreadId", action.threadId)).first();
    await ctx.db.patch(thread._id, { status: queuedMessage ? "queued" : action.resumeStatus });
    return null;
  },
});
