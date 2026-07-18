/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

test("records each model call once and atomically rolls usage into its thread", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "usage" });
  const messageId = await t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId });
  await owner.mutation(api.usage.setBudget, { budgetUsd: 0.08, threadId });
  const input = {
    callId: "call-1",
    messageId,
    modelId: "anthropic/claude-sonnet-4-5",
    role: "primary",
    threadId,
    usage: { cacheReadTokens: 2_000, cacheWriteTokens: 1_000, inputTokens: 10_000, outputTokens: 4_000, thinkingTokens: 1_000 },
  };

  await Promise.all([t.mutation(api.usage.record, { ...input, deviceToken }), t.mutation(api.usage.record, { ...input, deviceToken })]);

  expect(await owner.query(api.usage.forThread, { threadId })).toMatchObject({
    budgetUsd: 0.08,
    records: [{ callId: "call-1", costUsd: 0.08535, messageId, modelId: "anthropic/claude-sonnet-4-5", role: "primary", ...input.usage }],
    totals: { cacheReadTokens: 2_000, cacheWriteTokens: 1_000, costUsd: 0.08535, inputTokens: 10_000, outputTokens: 4_000, thinkingTokens: 1_000, thinkingTokensUnavailableCalls: 0 },
  });

  await expect(t.mutation(api.usage.record, { ...input, deviceToken, modelId: "deepseek/deepseek-v4-flash" })).rejects.toThrow("Conflicting usage payload");
  await owner.mutation(api.usage.setBudget, { budgetUsd: null, threadId });
  expect(await owner.query(api.usage.forThread, { threadId })).toMatchObject({ budgetUsd: null });
});
