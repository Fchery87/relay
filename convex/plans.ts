import { DEFAULT_MODEL_ID, MODEL_CATALOG } from "@relay/shared";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireDeviceForThread, requireOwnedThread, requireUser } from "./auth_helpers";

const MAX_PLAN_SECTION_BYTES = 400_000;

export const getForThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    return ctx.db.query("plans").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).unique();
  },
});

export const updateModelPair = mutation({
  args: { buildModelId: v.string(), planModelId: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread || thread.mode !== "plan") throw new Error("Thread is not in plan mode");
    if (!MODEL_CATALOG.models.some((model) => model.id === args.planModelId) || !MODEL_CATALOG.models.some((model) => model.id === args.buildModelId)) throw new Error("Model is not in the catalog");
    if (thread.planPhase !== "planning" || thread.status !== "idle") throw new Error("Model pair can only change before planning starts");
    await ctx.db.patch(args.threadId, { buildModelId: args.buildModelId, planModelId: args.planModelId });
  },
});

export const completePlanning = mutation({
  args: { content: v.string(), deviceToken: v.string(), messageId: v.id("messages"), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    if (utf8Bytes(args.content) > MAX_PLAN_SECTION_BYTES) throw new Error("Plan exceeds its size limit");
    const [thread, message] = await Promise.all([ctx.db.get("threads", args.threadId), ctx.db.get("messages", args.messageId)]);
    if (!thread || thread.mode !== "plan" || thread.planPhase !== "planning" || thread.activeAssistantMessageId !== args.messageId || !message || message.threadId !== args.threadId) throw new Error("Planning completion does not match the active plan turn");
    if (thread.stopRequested === true) {
      await ctx.db.patch(args.messageId, { status: "complete" });
      const queued = await ctx.db.query("messages").withIndex("by_queued_thread", (q) => q.eq("queuedThreadId", args.threadId)).first();
      await ctx.db.patch(args.threadId, { activeAssistantMessageId: undefined, status: queued ? "queued" : "stopped", stopRequested: false });
      return;
    }
    const existing = await ctx.db.query("plans").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).unique();
    if (existing) await ctx.db.patch(existing._id, { content: args.content, revision: existing.revision + 1, status: "draft" });
    else await ctx.db.insert("plans", { content: args.content, revision: 0, status: "draft", threadId: args.threadId });
    await ctx.db.patch(args.messageId, { status: "complete" });
    await ctx.db.patch(args.threadId, { activeAssistantMessageId: undefined, planPhase: "review", status: "idle" });
  },
});

export const updateDraft = mutation({
  args: { content: v.string(), expectedRevision: v.number(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    if (utf8Bytes(args.content) > MAX_PLAN_SECTION_BYTES) throw new Error("Plan exceeds its size limit");
    const thread = await ctx.db.get("threads", args.threadId);
    const plan = await ctx.db.query("plans").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).unique();
    if (!thread || thread.planPhase !== "review" || !plan || plan.status !== "draft") throw new Error("Plan is not editable");
    if (plan.revision !== args.expectedRevision) throw new Error("Plan draft changed in another session");
    await ctx.db.patch(plan._id, { content: args.content, revision: plan.revision + 1 });
  },
});

export const approve = mutation({
  args: { content: v.string(), expectedRevision: v.number(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    if (utf8Bytes(args.content) > MAX_PLAN_SECTION_BYTES) throw new Error("Plan exceeds its size limit");
    const thread = await ctx.db.get("threads", args.threadId);
    const plan = await ctx.db.query("plans").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).unique();
    if (!thread || thread.planPhase !== "review" || !plan || plan.status !== "draft") throw new Error("Plan is not awaiting approval");
    if (plan.revision !== args.expectedRevision) throw new Error("Plan draft changed in another session");
    await ctx.db.patch(plan._id, { content: args.content, revision: plan.revision + 1, status: "approved" });
    const queued = await ctx.db.query("messages").withIndex("by_queued_thread", (q) => q.eq("queuedThreadId", args.threadId)).take(100);
    for (const message of queued) await ctx.db.patch(message._id, { queuedThreadId: undefined, status: "complete" });
    const followups = queued.length === 0 ? "" : `\n\n<queued_followups>\n${queued.map((message) => message.content).join("\n")}\n</queued_followups>`;
    const content = `Execute the approved plan.\n\n<approved_plan>\n${args.content}\n</approved_plan>${followups}`;
    await ctx.db.insert("messages", { content, queuedThreadId: args.threadId, role: "user", status: "queued", threadId: args.threadId });
    await ctx.db.patch(args.threadId, { buildModelId: thread.buildModelId ?? DEFAULT_MODEL_ID, planPhase: "building", status: "queued" });
  },
});

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
