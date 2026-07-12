import { internalMutationGeneric, makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { computeUsageCost, MODEL_CATALOG } from "@relay/shared";

const tokenUsage = v.object({
  cacheReadTokens: v.number(),
  cacheWriteTokens: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  thinkingTokens: v.union(v.number(), v.null()),
});

type UsageTotals = {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  thinkingTokensUnavailableCalls: number;
};

const EMPTY_TOTALS: UsageTotals = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  thinkingTokensUnavailableCalls: 0,
};

const removeForThreadBatchReference = makeFunctionReference<"mutation", { threadId: string }, null>("usage:removeForThreadBatch");

export const record = mutationGeneric({
  args: {
    callId: v.string(),
    messageId: v.id("messages"),
    modelId: v.string(),
    role: v.string(),
    threadId: v.id("threads"),
    usage: tokenUsage,
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("usage").withIndex("by_call_id", (q) => q.eq("callId", args.callId)).unique();
    if (existing) {
      if (!matchesExisting(existing, args)) throw new Error("Conflicting usage payload for call ID");
      return existing._id;
    }

    const [message, thread] = await Promise.all([ctx.db.get("messages", args.messageId), ctx.db.get("threads", args.threadId)]);
    if (!message || message.threadId !== args.threadId || message.role !== "assistant") throw new Error("Usage message must be an assistant message in the thread");
    if (!thread) throw new Error("Usage thread does not exist");
    const model = MODEL_CATALOG.models.find((entry) => entry.id === args.modelId);
    if (!model) throw new Error("Usage model is not in the catalog");
    if (!args.role.trim()) throw new Error("Usage role is required");
    const costUsd = computeUsageCost({ cost: model.cost, usage: args.usage });
    assertUsageValues({ costUsd, ...args.usage });

    const usageId = await ctx.db.insert("usage", { ...args.usage, callId: args.callId, costUsd, messageId: args.messageId, modelId: args.modelId, role: args.role, threadId: args.threadId });
    const current = thread.usageTotals ?? EMPTY_TOTALS;
    await ctx.db.patch(args.threadId, {
      usageTotals: {
        cacheReadTokens: current.cacheReadTokens + args.usage.cacheReadTokens,
        cacheWriteTokens: current.cacheWriteTokens + args.usage.cacheWriteTokens,
        costUsd: current.costUsd + costUsd,
        inputTokens: current.inputTokens + args.usage.inputTokens,
        outputTokens: current.outputTokens + args.usage.outputTokens,
        thinkingTokens: current.thinkingTokens + (args.usage.thinkingTokens ?? 0),
        thinkingTokensUnavailableCalls: current.thinkingTokensUnavailableCalls + (args.usage.thinkingTokens === null ? 1 : 0),
      },
    });
    return usageId;
  },
});

export const forThread = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) return null;
    const boundedRecords = await ctx.db.query("usage").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).order("desc").take(201);
    return { budgetUsd: thread.budgetUsd ?? null, records: boundedRecords.slice(0, 200), totals: thread.usageTotals ?? EMPTY_TOTALS, truncated: boundedRecords.length > 200 };
  },
});

export const setBudget = mutationGeneric({
  args: { budgetUsd: v.union(v.number(), v.null()), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    if (args.budgetUsd !== null && (!Number.isFinite(args.budgetUsd) || args.budgetUsd <= 0)) throw new Error("Budget must be a positive finite amount");
    await ctx.db.patch(args.threadId, { budgetUsd: args.budgetUsd ?? undefined });
  },
});

export const removeForThreadBatch = internalMutationGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const records = await ctx.db.query("usage").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).take(100);
    for (const record of records) await ctx.db.delete(record._id);
    if (records.length === 100) await ctx.scheduler.runAfter(0, removeForThreadBatchReference, args);
    return null;
  },
});

function assertUsageValues(values: Omit<UsageTotals, "thinkingTokens" | "thinkingTokensUnavailableCalls"> & { thinkingTokens: number | null }): void {
  for (const [name, value] of Object.entries({ ...values, thinkingTokens: undefined })) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
  }
  if (values.thinkingTokens !== null && (!Number.isFinite(values.thinkingTokens) || values.thinkingTokens < 0)) throw new Error("thinkingTokens must be a non-negative finite number or null");
  for (const [name, value] of Object.entries({ ...values, thinkingTokens: values.thinkingTokens ?? undefined })) {
    if (value === undefined) continue;
    if (name !== "costUsd" && !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  }
  if (values.cacheReadTokens + values.cacheWriteTokens > values.inputTokens) throw new Error("Cached tokens cannot exceed total input tokens");
  if (values.thinkingTokens !== null && values.thinkingTokens > values.outputTokens) throw new Error("Thinking tokens cannot exceed total output tokens");
}

function matchesExisting(existing: {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  messageId: string;
  modelId: string;
  outputTokens: number;
  role: string;
  thinkingTokens: number | null;
  threadId: string;
}, args: {
  messageId: string;
  modelId: string;
  role: string;
  threadId: string;
  usage: { cacheReadTokens: number; cacheWriteTokens: number; inputTokens: number; outputTokens: number; thinkingTokens: number | null };
}): boolean {
  return existing.messageId === args.messageId
    && existing.modelId === args.modelId
    && existing.role === args.role
    && existing.threadId === args.threadId
    && existing.cacheReadTokens === args.usage.cacheReadTokens
    && existing.cacheWriteTokens === args.usage.cacheWriteTokens
    && existing.inputTokens === args.usage.inputTokens
    && existing.outputTokens === args.usage.outputTokens
    && existing.thinkingTokens === args.usage.thinkingTokens;
}
