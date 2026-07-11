import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const action = v.union(v.literal("stage"), v.literal("commit"), v.literal("push"));

export const enqueue = mutationGeneric({
  args: { action, message: v.optional(v.string()), threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.insert("gitActions", { ...args, status: "queued" }),
});

export const listForThread = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.query("gitActions").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
});

export const claim = mutationGeneric({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    if (!machine) return null;
    const queued = await ctx.db.query("gitActions").withIndex("by_status", (q) => q.eq("status", "queued")).take(100);
    for (const item of queued) {
      const thread = await ctx.db.get("threads", item.threadId);
      if (!thread) continue;
      const project = await ctx.db.get("projects", thread.projectId);
      if (!project || project.machineId !== machine._id) continue;
      await ctx.db.patch(item._id, { status: "running" });
      return { action: item.action, actionId: item._id, message: item.message, projectPath: project.path, threadId: item.threadId };
    }
    return null;
  },
});

export const complete = mutationGeneric({
  args: { actionId: v.id("gitActions"), status: v.union(v.literal("complete"), v.literal("failed")) },
  handler: (ctx, args) => ctx.db.patch(args.actionId, { status: args.status }),
});
