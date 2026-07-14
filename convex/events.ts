import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireDeviceForThread, requireOwnedThread, requireUser } from "./auth_helpers";

export const list = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    return ctx.db.query("events").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect();
  },
});

export const appendCommandOutput = mutationGeneric({
  args: { deviceToken: v.string(), output: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    return ctx.db.insert("events", { kind: "command.output", output: args.output, threadId: args.threadId });
  },
});

export const appendToolCompleted = mutationGeneric({
  args: { deviceToken: v.string(), summary: v.string(), threadId: v.id("threads"), tool: v.union(v.literal("bash"), v.literal("edit"), v.literal("mcp"), v.literal("read"), v.literal("task")) },
  handler: async (ctx, args) => {
    await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    return ctx.db.insert("events", { kind: "tool.completed", summary: args.summary, threadId: args.threadId, tool: args.tool });
  },
});

export const appendMcpTaskStatus = mutationGeneric({
  args: { deviceToken: v.string(), serverId: v.string(), status: v.string(), taskId: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    return ctx.db.insert("events", { kind: "mcp.task", serverId: args.serverId, status: args.status, taskId: args.taskId, threadId: args.threadId });
  },
});
