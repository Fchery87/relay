/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";

const modules = import.meta.glob("./**/*.ts");

test("persists a thread model selection and returns it with the claimed turn", async () => {
  const t = convexTest(schema, modules);
  const projectId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { daemonVersion: "test", deviceToken: "device", lastHeartbeatAt: Date.now(), name: "machine", platform: "linux" });
    return ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
  });
  const threadId = await t.mutation(api.conversations.createThread, { projectId, title: "models" });
  await t.mutation(api.conversations.updateModelSelection, { modelId: "openai/gpt-5-mini", thinkingLevel: "high", threadId });
  await t.mutation(api.conversations.sendUserMessage, { content: "hello", threadId });

  expect(await t.mutation(api.conversations.claimQueuedMessage, { deviceToken: "device" })).toMatchObject({
    modelId: "openai/gpt-5-mini",
    thinkingLevel: "high",
  });
});

test("rejects unsupported thinking levels for the selected model", async () => {
  const t = convexTest(schema, modules);
  const projectId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { daemonVersion: "test", deviceToken: "device", lastHeartbeatAt: Date.now(), name: "machine", platform: "linux" });
    return ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
  });
  const threadId = await t.mutation(api.conversations.createThread, { projectId, title: "models" });
  await expect(t.mutation(api.conversations.updateModelSelection, { modelId: "deepseek/deepseek-chat", thinkingLevel: "high", threadId })).rejects.toThrow("Thinking level is not supported");
});
