/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

test("persists a thread model selection and returns it with the claimed turn", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "models" });
  await owner.mutation(api.conversations.updateModelSelection, { modelId: "openai/gpt-5-mini", thinkingLevel: "high", threadId });
  await owner.mutation(api.conversations.sendUserMessage, { content: "hello", threadId });

  expect(await t.mutation(api.conversations.claimQueuedMessage, { deviceToken })).toMatchObject({
    modelId: "openai/gpt-5-mini",
    thinkingLevel: "high",
  });
});

test("rejects unsupported thinking levels for the selected model", async () => {
  const t = convexTest(schema, modules);
  const { owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "models" });
  await expect(owner.mutation(api.conversations.updateModelSelection, { modelId: "deepseek/deepseek-v4-flash", thinkingLevel: "low", threadId })).rejects.toThrow("Thinking level is not supported");
});
