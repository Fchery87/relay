/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

test("a queued user message becomes persisted assistant history", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, machineId, owner, projectId } = await createAuthenticatedProject(t);

  expect(machineId).toBeDefined();
  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "test" });
  await owner.mutation(api.conversations.sendUserMessage, { content: "hello", threadId });
  const queued = await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });
  expect(queued).toMatchObject({ content: "hello", threadId });
  const assistantId = await t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId });
  await t.mutation(api.conversations.appendAssistantText, { content: "hello from scripted provider", deviceToken, messageId: assistantId });
  await t.mutation(api.conversations.completeAssistantMessage, { deviceToken, messageId: assistantId, status: "done", threadId });

  const history = await owner.query(api.conversations.listThreadMessages, { threadId });
  expect(history.map(({ content, role, status }) => ({ content, role, status }))).toEqual([
    { content: "hello", role: "user", status: "complete" },
    { content: "hello from scripted provider", role: "assistant", status: "complete" },
  ]);
});
