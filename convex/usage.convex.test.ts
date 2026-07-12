/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";

const modules = import.meta.glob("./**/*.ts");

test("records each model call once and atomically rolls usage into its thread", async () => {
  const t = convexTest(schema, modules);
  const projectId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { daemonVersion: "test", deviceToken: "device", lastHeartbeatAt: Date.now(), name: "machine", platform: "linux" });
    return ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
  });
  const threadId = await t.mutation(api.conversations.createThread, { projectId, title: "usage" });
  const messageId = await t.mutation(api.conversations.beginAssistantMessage, { threadId });
  await t.mutation(api.usage.setBudget, { budgetUsd: 0.08, threadId });
  const input = {
    callId: "call-1",
    messageId,
    modelId: "anthropic/claude-sonnet-4-5",
    role: "primary",
    threadId,
    usage: { cacheReadTokens: 2_000, cacheWriteTokens: 1_000, inputTokens: 10_000, outputTokens: 4_000, thinkingTokens: 1_000 },
  };

  await Promise.all([t.mutation(api.usage.record, input), t.mutation(api.usage.record, input)]);

  expect(await t.query(api.usage.forThread, { threadId })).toMatchObject({
    budgetUsd: 0.08,
    records: [{ callId: "call-1", costUsd: 0.08535, messageId, modelId: "anthropic/claude-sonnet-4-5", role: "primary", ...input.usage }],
    totals: { cacheReadTokens: 2_000, cacheWriteTokens: 1_000, costUsd: 0.08535, inputTokens: 10_000, outputTokens: 4_000, thinkingTokens: 1_000, thinkingTokensUnavailableCalls: 0 },
  });

  await expect(t.mutation(api.usage.record, { ...input, modelId: "deepseek/deepseek-chat" })).rejects.toThrow("Conflicting usage payload");
  await t.mutation(api.usage.setBudget, { budgetUsd: null, threadId });
  expect(await t.query(api.usage.forThread, { threadId })).toMatchObject({ budgetUsd: null });
});
