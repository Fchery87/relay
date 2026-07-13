import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const list = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.query("events").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
});

export const appendCommandOutput = mutationGeneric({
  args: { output: v.string(), threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.insert("events", { ...args, kind: "command.output" }),
});

export const appendToolCompleted = mutationGeneric({
  args: { summary: v.string(), threadId: v.id("threads"), tool: v.union(v.literal("bash"), v.literal("edit"), v.literal("mcp"), v.literal("read"), v.literal("task")) },
  handler: (ctx, args) => ctx.db.insert("events", { ...args, kind: "tool.completed" }),
});

export const appendMcpTaskStatus = mutationGeneric({
  args: { serverId: v.string(), status: v.string(), taskId: v.string(), threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.insert("events", { ...args, kind: "mcp.task" }),
});
