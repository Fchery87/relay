import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const enqueue = mutationGeneric({
  args: { command: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) throw new Error("Thread not found");
    if (thread.status === "restoring") throw new Error("Cannot run a command during checkpoint restore");
    return ctx.db.insert("commands", { ...args, status: "queued" });
  },
});

export const listForThread = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.query("commands").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
});

export const claim = mutationGeneric({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    if (!machine) return null;
    const queued = await ctx.db.query("commands").withIndex("by_status", (q) => q.eq("status", "queued")).take(100);
    for (const command of queued) {
      const thread = await ctx.db.get("threads", command.threadId);
      if (!thread) continue;
      if (thread.status === "running" || thread.status === "awaiting-approval" || thread.status === "restoring") continue;
      const project = await ctx.db.get("projects", thread.projectId);
      if (!project || project.machineId !== machine._id) continue;
      await ctx.db.patch(command._id, { status: "running" });
      return { command: command.command, commandId: command._id, projectPath: project.path, threadId: command.threadId };
    }
    return null;
  },
});

export const complete = mutationGeneric({
  args: { commandId: v.id("commands"), status: v.union(v.literal("complete"), v.literal("failed")) },
  handler: (ctx, args) => ctx.db.patch(args.commandId, { status: args.status }),
});
