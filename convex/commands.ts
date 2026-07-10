import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const enqueue = mutationGeneric({
  args: { command: v.string(), threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.insert("commands", { ...args, status: "queued" }),
});

export const listForThread = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.query("commands").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
});

export const claim = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    const command = await ctx.db.query("commands").withIndex("by_status", (q) => q.eq("status", "queued")).first();
    if (!command) return null;
    const thread = await ctx.db.get("threads", command.threadId);
    if (!thread) throw new Error("Command thread not found");
    const project = await ctx.db.get("projects", thread.projectId);
    if (!project) throw new Error("Command project not found");
    await ctx.db.patch(command._id, { status: "running" });
    return { command: command.command, commandId: command._id, projectPath: project.path, threadId: command.threadId };
  },
});

export const complete = mutationGeneric({
  args: { commandId: v.id("commands"), status: v.union(v.literal("complete"), v.literal("failed")) },
  handler: (ctx, args) => ctx.db.patch(args.commandId, { status: args.status }),
});
