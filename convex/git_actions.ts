import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireActiveMachine, requireDeviceForThread, requireOwnedThread, requireUser } from "./auth_helpers";

const action = v.union(v.literal("stage"), v.literal("commit"), v.literal("push"));

export const enqueue = mutationGeneric({
  args: { action, message: v.optional(v.string()), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) throw new Error("Thread not found");
    if (thread.status === "restoring") throw new Error("Cannot run a Git action during checkpoint restore");
    return ctx.db.insert("gitActions", { ...args, status: "queued" });
  },
});

export const listForThread = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    return ctx.db.query("gitActions").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).take(100);
  },
});

export const claim = mutationGeneric({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    const queued = await ctx.db.query("gitActions").withIndex("by_status", (q) => q.eq("status", "queued")).take(100);
    for (const item of queued) {
      const thread = await ctx.db.get("threads", item.threadId);
      if (!thread) continue;
      if (thread.status === "restoring") continue;
      const project = await ctx.db.get("projects", thread.projectId);
      if (!project || project.machineId !== machine._id) continue;
      await ctx.db.patch(item._id, { status: "running" });
      return { action: item.action, actionId: item._id, message: item.message, projectPath: project.path, threadId: item.threadId };
    }
    return null;
  },
});

export const complete = mutationGeneric({
  args: { actionId: v.id("gitActions"), deviceToken: v.string(), status: v.union(v.literal("complete"), v.literal("failed")) },
  handler: async (ctx, args) => {
    const action = await ctx.db.get("gitActions", args.actionId);
    if (!action) throw new Error("Git action not found");
    await requireDeviceForThread(ctx, args.deviceToken, action.threadId);
    await ctx.db.patch(args.actionId, { status: args.status });
  },
});
