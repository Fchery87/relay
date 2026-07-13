/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";

const modules = import.meta.glob("./**/*.ts");

test("plan mode pauses for editable approval then queues the approved plan for the build model", async () => {
  const t = convexTest(schema, modules);
  const projectId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { daemonVersion: "test", deviceToken: "device", lastHeartbeatAt: Date.now(), name: "machine", platform: "linux" });
    return ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
  });
  const threadId = await t.mutation(api.conversations.createThread, { mode: "plan", projectId, title: "Plan feature" });
  await t.mutation(api.plans.updateModelPair, { buildModelId: "openai/gpt-5-mini", planModelId: "deepseek/deepseek-chat", threadId });
  await t.mutation(api.conversations.sendUserMessage, { content: "Plan authentication", threadId });
  for (let index = 1; index < 100; index += 1) await t.mutation(api.conversations.sendUserMessage, { content: `Offline follow-up ${index}`, threadId });
  await expect(t.mutation(api.conversations.sendUserMessage, { content: "Offline overflow", threadId })).rejects.toThrow("queue is full");
  expect(await t.mutation(api.conversations.claimQueuedMessage, { deviceToken: "device" })).toMatchObject({ modelId: "deepseek/deepseek-chat", planPhase: "planning" });
  const messageId = await t.mutation(api.conversations.beginAssistantMessage, { threadId });
  await t.mutation(api.conversations.sendUserMessage, { content: "Also cover tests", threadId });
  await expect(t.mutation(api.conversations.sendUserMessage, { content: "Overflow", threadId })).rejects.toThrow("queue is full");
  await t.mutation(api.plans.completePlanning, { content: "1. Add schema\n2. Add UI", messageId, threadId });
  expect(await t.query(api.plans.getForThread, { threadId })).toMatchObject({ content: "1. Add schema\n2. Add UI", revision: 0, status: "draft" });
  expect(await t.mutation(api.conversations.claimQueuedMessage, { deviceToken: "device" })).toBeNull();
  await t.mutation(api.plans.updateDraft, { content: "1. Add schema\n2. Add tests\n3. Add UI", expectedRevision: 0, threadId });
  await t.mutation(api.plans.approve, { content: "1. Add schema\n2. Add tests\n3. Add UI", expectedRevision: 1, threadId });
  const build = await t.mutation(api.conversations.claimQueuedMessage, { deviceToken: "device" });
  expect(build).toMatchObject({ modelId: "openai/gpt-5-mini", planPhase: "building" });
  expect(build?.content).toContain("2. Add tests");
  expect(build?.content).toContain("Also cover tests");

  const stoppedThreadId = await t.mutation(api.conversations.createThread, { mode: "plan", projectId, title: "Stopped plan" });
  await t.mutation(api.conversations.sendUserMessage, { content: "Plan stopping", threadId: stoppedThreadId });
  await t.mutation(api.conversations.claimQueuedMessage, { deviceToken: "device" });
  const stoppedMessageId = await t.mutation(api.conversations.beginAssistantMessage, { threadId: stoppedThreadId });
  await t.mutation(api.conversations.requestStop, { threadId: stoppedThreadId });
  await t.mutation(api.plans.completePlanning, { content: "Must not persist", messageId: stoppedMessageId, threadId: stoppedThreadId });
  expect(await t.query(api.plans.getForThread, { threadId: stoppedThreadId })).toBeNull();
  expect(await t.run((ctx) => ctx.db.get("threads", stoppedThreadId))).toMatchObject({ status: "stopped", stopRequested: false });

  await t.mutation(api.conversations.removeThread, { threadId });
  expect(await t.run((ctx) => ctx.db.query("plans").collect())).toEqual([]);

  const boundedThreadId = await t.mutation(api.conversations.createThread, { mode: "plan", projectId, title: "Bounded plan" });
  await t.mutation(api.conversations.sendUserMessage, { content: "x".repeat(200_000), threadId: boundedThreadId });
  await t.mutation(api.conversations.sendUserMessage, { content: "y".repeat(200_000), threadId: boundedThreadId });
  await expect(t.mutation(api.conversations.sendUserMessage, { content: "z", threadId: boundedThreadId })).rejects.toThrow("size limit");
});
