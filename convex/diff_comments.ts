import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const create = mutationGeneric({
  args: {
    content: v.string(),
    endLine: v.number(),
    filePath: v.string(),
    startLine: v.number(),
    threadId: v.id("threads"),
  },
  handler: (ctx, args) => {
    if (!args.content.trim()) throw new Error("Comment content is required");
    if (!Number.isInteger(args.startLine) || !Number.isInteger(args.endLine) || args.startLine < 1 || args.endLine < args.startLine) {
      throw new Error("Comment line range is invalid");
    }
    return ctx.db.insert("diffComments", { ...args, content: args.content.trim(), resolved: false });
  },
});

export const listForThread = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.query("diffComments").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
});
