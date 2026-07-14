import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireDeviceForThread, requireOwnedThread, requireUser } from "./auth_helpers";

export const latest = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    return ctx.db.query("diffs").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).order("desc").first();
  },
});

export const snapshot = mutationGeneric({
  args: { content: v.string(), deviceToken: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    return ctx.db.insert("diffs", { content: args.content, threadId: args.threadId });
  },
});
