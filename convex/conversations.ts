import { makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { DEFAULT_MODEL_ID, MODEL_CATALOG, listThinkingLevels } from "@relay/shared";

const threadStatus = v.union(v.literal("idle"), v.literal("queued"), v.literal("running"), v.literal("awaiting-approval"), v.literal("restoring"), v.literal("stopped"), v.literal("done"), v.literal("failed"));
const removeUsageForThread = makeFunctionReference<"mutation", { threadId: string }, null>("usage:removeForThreadBatch");

export const createThread = mutationGeneric({
  args: { projectId: v.id("projects"), title: v.string() },
  handler: (ctx, args) => ctx.db.insert("threads", {
    ...args,
    modelId: DEFAULT_MODEL_ID,
    status: "idle",
    stopRequested: false,
    thinkingLevel: "none",
    usageTotals: { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, thinkingTokensUnavailableCalls: 0 },
  }),
});

export const updateModelSelection = mutationGeneric({
  args: { modelId: v.string(), thinkingLevel: v.union(v.literal("none"), v.literal("low"), v.literal("medium"), v.literal("high")), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const model = MODEL_CATALOG.models.find((entry) => entry.id === args.modelId);
    if (!model) throw new Error("Model is not in the catalog");
    if (!listThinkingLevels(model).includes(args.thinkingLevel)) throw new Error("Thinking level is not supported by this model");
    await ctx.db.patch(args.threadId, { modelId: args.modelId, thinkingLevel: args.thinkingLevel });
  },
});

export const sendUserMessage = mutationGeneric({
  args: { content: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const messageId = await ctx.db.insert("messages", { ...args, queuedThreadId: args.threadId, role: "user", status: "queued" });
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) throw new Error("Thread not found");
    if (thread.status !== "running" && thread.status !== "awaiting-approval" && thread.status !== "restoring") await ctx.db.patch(args.threadId, { status: "queued" });
    return messageId;
  },
});

export const claimSteeringMessages = mutationGeneric({
  args: { deviceToken: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    if (!machine) throw new Error("Unknown development device token");
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread || thread.status !== "running" || thread.stopRequested === true) return [];
    const project = await ctx.db.get("projects", thread.projectId);
    if (!project || project.machineId !== machine._id) return [];
    const messages = await ctx.db.query("messages").withIndex("by_queued_thread", (q) => q.eq("queuedThreadId", args.threadId)).take(100);
    for (const message of messages) await ctx.db.patch(message._id, { queuedThreadId: undefined, status: "complete" });
    return messages.map(({ content }) => ({ content }));
  },
});

export const requestStop = mutationGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) throw new Error("Thread not found");
    if (thread.status !== "running") throw new Error("Only a running thread can be stopped");
    await ctx.db.patch(args.threadId, { stopRequested: true });
  },
});

export const getStopState = queryGeneric({
  args: { deviceToken: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    if (!machine) throw new Error("Unknown development device token");
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) return { requested: false };
    const project = await ctx.db.get("projects", thread.projectId);
    return { requested: project?.machineId === machine._id && thread.stopRequested === true };
  },
});

export const acknowledgeStop = mutationGeneric({
  args: { deviceToken: v.string(), messageId: v.id("messages"), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    if (!machine) throw new Error("Unknown development device token");
    const [message, thread] = await Promise.all([ctx.db.get("messages", args.messageId), ctx.db.get("threads", args.threadId)]);
    if (!message || message.threadId !== args.threadId || !thread || thread.activeAssistantMessageId !== args.messageId) throw new Error("Stop acknowledgement does not match the active turn");
    if (thread.status !== "running" || thread.stopRequested !== true) throw new Error("Stop was not requested for the active turn");
    const project = await ctx.db.get("projects", thread.projectId);
    if (!project || project.machineId !== machine._id) throw new Error("Stop acknowledgement does not belong to this machine");
    await ctx.db.patch(args.messageId, { status: "complete" });
    const queued = await ctx.db.query("messages").withIndex("by_queued_thread", (q) => q.eq("queuedThreadId", args.threadId)).first();
    await ctx.db.patch(args.threadId, { activeAssistantMessageId: undefined, status: queued ? "queued" : "stopped", stopRequested: false });
  },
});

export const listThreadMessages = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
});

export const listProjectThreads = queryGeneric({
  args: { projectId: v.id("projects") },
  handler: (ctx, args) => ctx.db.query("threads").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).collect(),
});

export const listThreadIds = queryGeneric({
  args: {},
  handler: async (ctx) => (await ctx.db.query("threads").collect()).map((thread) => thread._id),
});

export const removeThread = mutationGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    for await (const event of ctx.db.query("events").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(event._id);
    for await (const comparison of ctx.db.query("checkpointComparisons").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(comparison._id);
    for await (const action of ctx.db.query("checkpointActions").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(action._id);
    for await (const checkpoint of ctx.db.query("checkpoints").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(checkpoint._id);
    for await (const message of ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(message._id);
    for await (const comment of ctx.db.query("diffComments").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(comment._id);
    for await (const approval of ctx.db.query("approvals").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(approval._id);
    for await (const audit of ctx.db.query("auditLog").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(audit._id);
    await ctx.scheduler.runAfter(0, removeUsageForThread, { threadId: args.threadId });
    await ctx.db.delete(args.threadId);
  },
});

export const claimQueuedMessage = mutationGeneric({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    if (!machine) throw new Error("Unknown development device token");

    for await (const message of ctx.db.query("messages").withIndex("by_status", (q) => q.eq("status", "queued"))) {
      const thread = await ctx.db.get("threads", message.threadId);
      if (!thread) continue;
      if (thread.status === "running" || thread.status === "awaiting-approval" || thread.status === "restoring" || thread.status === "stopped") continue;
      const project = await ctx.db.get("projects", thread.projectId);
      if (!project || project.machineId !== machine._id) continue;
      const reviewComments = await ctx.db.query("diffComments")
        .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
        .filter((q) => q.eq(q.field("resolved"), false))
        .collect();
      await ctx.db.patch(message._id, { queuedThreadId: undefined, status: "complete" });
      await ctx.db.patch(thread._id, { status: "running" });
      return {
        content: message.content,
        modelId: thread.modelId ?? DEFAULT_MODEL_ID,
        projectPath: project.path,
        reviewComments: reviewComments.map((comment) => ({
          commentId: comment._id,
          content: comment.content,
          endLine: comment.endLine,
          filePath: comment.filePath,
          startLine: comment.startLine,
        })),
        threadId: thread._id,
        thinkingLevel: thread.thinkingLevel ?? "none",
      };
    }
    return null;
  },
});

export const beginAssistantMessage = mutationGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const messageId = await ctx.db.insert("messages", { content: "", role: "assistant", status: "streaming", threadId: args.threadId });
    await ctx.db.patch(args.threadId, { activeAssistantMessageId: messageId });
    return messageId;
  },
});

export const appendAssistantText = mutationGeneric({
  args: { content: v.string(), messageId: v.id("messages") },
  handler: (ctx, args) => ctx.db.patch(args.messageId, { content: args.content }),
});

export const completeAssistantMessage = mutationGeneric({
  args: { messageId: v.id("messages"), resolvedCommentIds: v.optional(v.array(v.id("diffComments"))), threadId: v.id("threads"), status: threadStatus },
  handler: async (ctx, args) => {
    const [message, thread] = await Promise.all([ctx.db.get("messages", args.messageId), ctx.db.get("threads", args.threadId)]);
    if (!message || message.threadId !== args.threadId || !thread || thread.activeAssistantMessageId !== args.messageId) throw new Error("Assistant completion does not match the active turn");
    if (args.status === "done" && thread.stopRequested === true) {
      await ctx.db.patch(args.messageId, { status: "complete" });
      const queued = await ctx.db.query("messages").withIndex("by_queued_thread", (q) => q.eq("queuedThreadId", args.threadId)).first();
      await ctx.db.patch(args.threadId, { activeAssistantMessageId: undefined, status: queued ? "queued" : "stopped", stopRequested: false });
      return;
    }
    if (args.status === "done") {
      for (const commentId of args.resolvedCommentIds ?? []) {
        const comment = await ctx.db.get("diffComments", commentId);
        if (comment?.threadId === args.threadId) await ctx.db.patch(commentId, { resolved: true });
      }
    }
    await ctx.db.patch(args.messageId, { status: "complete" });
    const queued = args.status === "done"
      ? await ctx.db.query("messages").withIndex("by_queued_thread", (q) => q.eq("queuedThreadId", args.threadId)).first()
      : null;
    await ctx.db.patch(args.threadId, { activeAssistantMessageId: undefined, status: queued ? "queued" : args.status });
  },
});
