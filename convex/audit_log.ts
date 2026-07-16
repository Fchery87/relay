import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireDeviceForThread, requireOwnedThread, requireUser } from "./auth_helpers";

const capability = v.union(v.literal("read"), v.literal("edit"), v.literal("exec"), v.literal("task"));
const decision = v.union(v.literal("allow"), v.literal("deny"), v.literal("ask"));
const risk = v.union(v.literal("low"), v.literal("high"), v.literal("critical"));

export const record = mutationGeneric({
  args: { capability, decision, deviceToken: v.string(), risk, summary: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    return ctx.db.insert("auditLog", { capability: args.capability, decision: args.decision, risk: args.risk, summary: args.summary, threadId: args.threadId });
  },
});

export const listForThread = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    return ctx.db.query("auditLog").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect();
  },
});

export const listForThreadPaginated = queryGeneric({
  args: {
    cursor: v.optional(v.string()),
    limit: v.number(),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    return ctx.db
      .query("auditLog")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
  },
});
