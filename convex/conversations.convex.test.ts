/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";

const modules = import.meta.glob("./**/*.ts");

test("a queued user message becomes persisted assistant history", async () => {
  const t = convexTest(schema, modules);
  const { machineId, projectId } = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", {
      daemonVersion: "test",
      deviceToken: "device-token",
      lastHeartbeatAt: Date.now(),
      name: "test-machine",
      platform: "linux",
    });
    const projectId = await ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
    return { machineId, projectId };
  });

  expect(machineId).toBeDefined();
  const threadId = await t.mutation(api.conversations.createThread, { projectId, title: "test" });
  await t.mutation(api.conversations.sendUserMessage, { content: "hello", threadId });
  const queued = await t.mutation(api.conversations.claimQueuedMessage, { deviceToken: "device-token" });
  expect(queued).toMatchObject({ content: "hello", threadId });
  const assistantId = await t.mutation(api.conversations.beginAssistantMessage, { threadId });
  await t.mutation(api.conversations.appendAssistantText, { content: "hello from scripted provider", messageId: assistantId });
  await t.mutation(api.conversations.completeAssistantMessage, { messageId: assistantId, status: "done", threadId });

  const history = await t.query(api.conversations.listThreadMessages, { threadId });
  expect(history.map(({ content, role, status }) => ({ content, role, status }))).toEqual([
    { content: "hello", role: "user", status: "complete" },
    { content: "hello from scripted provider", role: "assistant", status: "complete" },
  ]);
});
