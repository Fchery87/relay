import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireDeviceForThread, requireOwnedThread, requireUser } from "./auth_helpers";

const capability = v.union(v.literal("read"), v.literal("edit"), v.literal("exec"), v.literal("task"), v.literal("search"));
const risk = v.union(v.literal("low"), v.literal("high"), v.literal("critical"));

function toPublicApproval<T extends { continuationJson?: string; turnId?: string }>(approval: T) {
  const { continuationJson: _continuationJson, turnId: _turnId, ...publicApproval } = approval;
  return publicApproval;
}

export const create = mutationGeneric({
  args: { capability, continuationJson: v.optional(v.string()), deviceToken: v.string(), risk, summary: v.string(), threadId: v.id("threads"), turnId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const machine = await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) throw new Error("Approval thread not found");
    if (thread.status === "awaiting-approval") throw new Error("Thread already awaits approval");
    const approvalId = await ctx.db.insert("approvals", { capability: args.capability, continuationJson: args.continuationJson, decision: "pending", resumeStatus: thread.status, risk: args.risk, summary: args.summary, threadId: args.threadId, turnId: args.turnId });
    await ctx.db.insert("auditLog", {
      action: "approval.requested",
      actorId: machine._id,
      actorKind: "device",
      capability: args.capability,
      category: "approval",
      correlationId: `approval:${approvalId}`,
      decision: "ask",
      machineId: machine._id,
      policyVersion: "policy-v1",
      projectId: thread.projectId,
      requestedScope: args.capability,
      risk: args.risk,
      summary: args.summary,
      threadId: args.threadId,
      effectiveScope: "pending",
    });
    await ctx.db.patch(args.threadId, { status: "awaiting-approval" });
    return approvalId;
  },
});

export const get = queryGeneric({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const approval = await ctx.db.get("approvals", args.approvalId);
    if (!approval) return null;
    await requireOwnedThread(ctx, userId, approval.threadId);
    return toPublicApproval(approval);
  },
});

export const listForThread = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    const approvals = await ctx.db.query("approvals").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect();
    return approvals.map(toPublicApproval);
  },
});

export const resolve = mutationGeneric({
  args: { approvalId: v.id("approvals"), decision: v.union(v.literal("allow"), v.literal("deny")) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const approval = await ctx.db.get("approvals", args.approvalId);
    if (!approval) throw new Error("Approval not found");
    const thread = await requireOwnedThread(ctx, userId, approval.threadId);
    const project = await ctx.db.get(thread.projectId);
    const machine = project ? await ctx.db.get(project.machineId) : null;
    if (approval.decision !== "pending") throw new Error("Approval already resolved");
    await ctx.db.patch(approval._id, { decision: args.decision });
    await ctx.db.insert("auditLog", {
      action: `approval.${args.decision}`,
      actorId: userId,
      actorKind: "user",
      capability: approval.capability,
      category: "approval",
      correlationId: `approval:${approval._id}`,
      decision: args.decision,
      ...(machine ? { machineId: machine._id } : {}),
      policyVersion: "policy-v1",
      projectId: thread.projectId,
      requestedScope: approval.capability,
      risk: approval.risk,
      summary: approval.summary,
      threadId: approval.threadId,
      effectiveScope: args.decision === "allow" ? approval.capability : "none",
    });
    await ctx.db.patch(approval.threadId, { status: approval.resumeStatus ?? "running" });
  },
});

// --- Device-scoped queries (fixes daemon approval-auth failure) ---

export const getByDevice = queryGeneric({
  args: { approvalId: v.id("approvals"), deviceToken: v.string() },
  handler: async (ctx, args) => {
    const approval = await ctx.db.get("approvals", args.approvalId);
    if (!approval) return null;
    await requireDeviceForThread(ctx, args.deviceToken, approval.threadId);
    return approval;
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
    const page = await ctx.db
      .query("approvals")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
    return { ...page, page: page.page.map(toPublicApproval) };
  },
});
