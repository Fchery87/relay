import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireDeviceForThread, requireOwnedThread, requireUser } from "./auth_helpers";

const capability = v.union(v.literal("read"), v.literal("edit"), v.literal("exec"), v.literal("task"), v.literal("search"));
const decision = v.union(v.literal("allow"), v.literal("deny"), v.literal("ask"));
const risk = v.union(v.literal("low"), v.literal("high"), v.literal("critical"));

export const record = mutationGeneric({
  args: {
    capability,
    causationId: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    decision,
    deviceToken: v.string(),
    policyVersion: v.optional(v.string()),
    requestedScope: v.optional(v.string()),
    risk,
    summary: v.string(),
    threadId: v.id("threads"),
    effectiveScope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const machine = await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new Error("Audit thread not found");
    return ctx.db.insert("auditLog", {
      action: `governance.${args.decision}`,
      actorId: machine._id,
      actorKind: "device",
      capability: args.capability,
      causationId: args.causationId,
      category: "governance",
      correlationId: args.correlationId ?? `governance:${args.threadId}:${Date.now()}`,
      decision: args.decision,
      machineId: machine._id,
      policyVersion: args.policyVersion ?? "policy-v1",
      projectId: thread.projectId,
      requestedScope: args.requestedScope ?? args.capability,
      risk: args.risk,
      summary: args.summary,
      threadId: args.threadId,
      effectiveScope: args.effectiveScope ?? (args.decision === "allow" ? args.capability : "none"),
    });
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
