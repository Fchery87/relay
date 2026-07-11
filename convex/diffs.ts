import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const latest = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.query("diffs").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).order("desc").first(),
});

export const snapshot = mutationGeneric({
  args: { content: v.string(), threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.insert("diffs", args),
});
