import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const capability = v.union(v.literal("read"), v.literal("edit"), v.literal("exec"), v.literal("task"));
const risk = v.union(v.literal("low"), v.literal("high"), v.literal("critical"));

export const create = mutationGeneric({
  args: { capability, risk, summary: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) throw new Error("Approval thread not found");
    if (thread.status === "awaiting-approval") throw new Error("Thread already awaits approval");
    const approvalId = await ctx.db.insert("approvals", { ...args, decision: "pending", resumeStatus: thread.status });
    await ctx.db.insert("auditLog", { ...args, decision: "ask" });
    await ctx.db.patch(args.threadId, { status: "awaiting-approval" });
    return approvalId;
  },
});

export const get = queryGeneric({
  args: { approvalId: v.id("approvals") },
  handler: (ctx, args) => ctx.db.get("approvals", args.approvalId),
});

export const listForThread = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.query("approvals").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
});

export const resolve = mutationGeneric({
  args: { approvalId: v.id("approvals"), decision: v.union(v.literal("allow"), v.literal("deny")) },
  handler: async (ctx, args) => {
    const approval = await ctx.db.get("approvals", args.approvalId);
    if (!approval) throw new Error("Approval not found");
    if (approval.decision !== "pending") throw new Error("Approval already resolved");
    await ctx.db.patch(approval._id, { decision: args.decision });
    await ctx.db.insert("auditLog", {
      capability: approval.capability,
      decision: args.decision,
      risk: approval.risk,
      summary: approval.summary,
      threadId: approval.threadId,
    });
    await ctx.db.patch(approval.threadId, { status: approval.resumeStatus ?? "running" });
  },
});
