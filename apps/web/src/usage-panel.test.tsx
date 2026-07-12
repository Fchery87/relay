import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { UsagePanel } from "./usage-panel";

test("renders thread totals, cache rate, budget warning, and per-turn usage", () => {
  const markup = renderToStaticMarkup(<UsagePanel onBudgetChange={async () => undefined} value={{
    budgetUsd: 0.08,
    records: [{
      _creationTime: 1,
      _id: "usage-1",
      cacheReadTokens: 2_000,
      cacheWriteTokens: 1_000,
      callId: "call-1",
      costUsd: 0.08535,
      inputTokens: 10_000,
      messageId: "message-1",
      modelId: "anthropic/claude-sonnet-4-5",
      outputTokens: 4_000,
      role: "primary",
      thinkingTokens: 1_000,
      threadId: "thread-1",
    }],
    totals: { cacheReadTokens: 2_000, cacheWriteTokens: 1_000, costUsd: 0.08535, inputTokens: 10_000, outputTokens: 4_000, thinkingTokens: 1_000, thinkingTokensUnavailableCalls: 0 },
    truncated: false,
  }} />);

  expect(markup).toContain("$0.0854");
  expect(markup).toContain("14,000 tokens");
  expect(markup).toContain("20% cache hit");
  expect(markup).toContain("Budget exceeded");
  expect(markup).toContain("anthropic/claude-sonnet-4-5");
  expect(markup).toContain("10,000 in");
  expect(markup).toContain("4,000 out");
  expect(markup).toContain("1,000 thinking");
  expect(markup).toContain("Set budget");
  expect(markup).toContain("Clear budget");
  expect(markup).toContain('aria-live="polite"');
});

test("discloses when the bounded call history is truncated", () => {
  const markup = renderToStaticMarkup(<UsagePanel value={{ ...EMPTY, truncated: true }} />);
  expect(markup).toContain("Showing the latest 200 calls");
});

const EMPTY = {
  budgetUsd: null,
  records: [],
  totals: { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, thinkingTokensUnavailableCalls: 0 },
};
