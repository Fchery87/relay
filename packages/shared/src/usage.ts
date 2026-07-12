import { z } from "zod";

import type { CatalogModel } from "./model-catalog";

export const tokenUsageSchema = z.object({
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  thinkingTokens: z.number().int().nonnegative().nullable(),
}).superRefine((usage, ctx) => {
  if (usage.cacheReadTokens + usage.cacheWriteTokens > usage.inputTokens) {
    ctx.addIssue({ code: "custom", message: "Cached tokens cannot exceed total input tokens" });
  }
  if (usage.thinkingTokens !== null && usage.thinkingTokens > usage.outputTokens) {
    ctx.addIssue({ code: "custom", message: "Thinking tokens cannot exceed total output tokens" });
  }
});

export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export function computeUsageCost({ cost, usage }: { cost: CatalogModel["cost"]; usage: TokenUsage }): number {
  const freshInputTokens = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  const inputCost = freshInputTokens * cost.input;
  const cacheReadCost = usage.cacheReadTokens * (cost.cacheRead ?? cost.input);
  const cacheWriteCost = usage.cacheWriteTokens * (cost.cacheWrite ?? cost.input);
  const outputCost = usage.outputTokens * cost.output;
  return (inputCost + cacheReadCost + cacheWriteCost + outputCost) / 1_000_000;
}
