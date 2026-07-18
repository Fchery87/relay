import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

import { requireActiveMachine, requireUser } from "./auth_helpers";

export const update = mutationGeneric({
  args: {
    deviceToken: v.string(),
    items: v.array(v.object({ content: v.string(), status: v.union(v.literal("pending"), v.literal("in_progress"), v.literal("completed")) })),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    await requireActiveMachine(ctx, args.deviceToken);
    const capped = args.items.slice(0, 50);
    const existing = await ctx.db.query("todos").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).unique();
    if (existing) {
      await ctx.db.patch(existing._id, { items: capped, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("todos", { items: capped, threadId: args.threadId, updatedAt: Date.now() });
    }
  },
});

export const getForThread = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const todo = await ctx.db.query("todos").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).unique();
    return todo ? { items: todo.items, updatedAt: todo.updatedAt } : null;
  },
});
