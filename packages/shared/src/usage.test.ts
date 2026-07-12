import { expect, test } from "bun:test";

import { computeUsageCost } from "./usage";

test("prices fresh, cached, and cache-write input without double-charging thinking tokens", () => {
  const costUsd = computeUsageCost({
    cost: { cacheRead: 0.3, cacheWrite: 3.75, input: 3, output: 15 },
    usage: {
      cacheReadTokens: 2_000,
      cacheWriteTokens: 1_000,
      inputTokens: 10_000,
      outputTokens: 4_000,
      thinkingTokens: 1_000,
    },
  });

  expect(costUsd).toBeCloseTo(0.08535, 8);
});

test("uses ordinary input pricing when a catalog omits cache rates", () => {
  const costUsd = computeUsageCost({
    cost: { input: 2, output: 8 },
    usage: {
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
      inputTokens: 1_000,
      outputTokens: 500,
      thinkingTokens: 0,
    },
  });

  expect(costUsd).toBeCloseTo(0.006, 8);
});
