/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

test("plan mode pauses for editable approval then queues the approved plan for the build model", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await owner.mutation(api.conversations.createThread, { mode: "plan", projectId, title: "Plan feature" });
  await owner.mutation(api.plans.updateModelPair, { buildModelId: "openai/gpt-5-mini", planModelId: "deepseek/deepseek-v4-flash", threadId });
  await owner.mutation(api.conversations.sendUserMessage, { content: "Plan authentication", threadId });
  for (let index = 1; index < 100; index += 1) await owner.mutation(api.conversations.sendUserMessage, { content: `Offline follow-up ${index}`, threadId });
  await expect(owner.mutation(api.conversations.sendUserMessage, { content: "Offline overflow", threadId })).rejects.toThrow("queue is full");
  expect(await t.mutation(api.conversations.claimQueuedMessage, { deviceToken })).toMatchObject({ modelId: "deepseek/deepseek-v4-flash", planPhase: "planning" });
  const messageId = await t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId });
  await owner.mutation(api.conversations.sendUserMessage, { content: "Also cover tests", threadId });
  await expect(owner.mutation(api.conversations.sendUserMessage, { content: "Overflow", threadId })).rejects.toThrow("queue is full");
  await t.mutation(api.plans.completePlanning, { content: "1. Add schema\n2. Add UI", deviceToken, messageId, threadId });
  expect(await owner.query(api.plans.getForThread, { threadId })).toMatchObject({ content: "1. Add schema\n2. Add UI", revision: 0, status: "draft" });
  expect(await t.mutation(api.conversations.claimQueuedMessage, { deviceToken })).toBeNull();
  await owner.mutation(api.plans.updateDraft, { content: "1. Add schema\n2. Add tests\n3. Add UI", expectedRevision: 0, threadId });
  await owner.mutation(api.plans.approve, { content: "1. Add schema\n2. Add tests\n3. Add UI", expectedRevision: 1, threadId });
  const build = await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });
  expect(build).toMatchObject({ modelId: "openai/gpt-5-mini", planPhase: "building" });
  expect(build?.content).toContain("2. Add tests");
  expect(build?.content).toContain("Also cover tests");

  const stoppedThreadId = await owner.mutation(api.conversations.createThread, { mode: "plan", projectId, title: "Stopped plan" });
  await owner.mutation(api.conversations.sendUserMessage, { content: "Plan stopping", threadId: stoppedThreadId });
  await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });
  const stoppedMessageId = await t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId: stoppedThreadId });
  await owner.mutation(api.conversations.requestStop, { threadId: stoppedThreadId });
  await t.mutation(api.plans.completePlanning, { content: "Must not persist", deviceToken, messageId: stoppedMessageId, threadId: stoppedThreadId });
  expect(await owner.query(api.plans.getForThread, { threadId: stoppedThreadId })).toBeNull();
  expect(await t.run((ctx) => ctx.db.get("threads", stoppedThreadId))).toMatchObject({ status: "stopped", stopRequested: false });

  await owner.mutation(api.conversations.removeThread, { threadId });
  expect(await t.run((ctx) => ctx.db.query("plans").collect())).toEqual([]);

  const boundedThreadId = await owner.mutation(api.conversations.createThread, { mode: "plan", projectId, title: "Bounded plan" });
  await owner.mutation(api.conversations.sendUserMessage, { content: "x".repeat(200_000), threadId: boundedThreadId });
  await owner.mutation(api.conversations.sendUserMessage, { content: "y".repeat(200_000), threadId: boundedThreadId });
  await expect(owner.mutation(api.conversations.sendUserMessage, { content: "z", threadId: boundedThreadId })).rejects.toThrow("size limit");
});
