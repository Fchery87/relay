/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

test("mid-run messages stay queued and are claimed at a tool boundary without resolving approval", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "steering" });
  await owner.mutation(api.conversations.sendUserMessage, { content: "start", threadId });
  await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });

  await owner.mutation(api.conversations.sendUserMessage, { content: "first steer", threadId });
  expect((await t.run((ctx) => ctx.db.get("threads", threadId)))?.status).toBe("running");

  const approvalId = await t.mutation(api.approvals.create, { capability: "exec", deviceToken, risk: "high", summary: "dangerous command", threadId });
  await owner.mutation(api.conversations.sendUserMessage, { content: "second steer", threadId });
  expect(await owner.query(api.approvals.get, { approvalId })).toMatchObject({ decision: "pending" });
  expect((await t.run((ctx) => ctx.db.get("threads", threadId)))?.status).toBe("awaiting-approval");

  await owner.mutation(api.approvals.resolve, { approvalId, decision: "allow" });
  expect(await t.mutation(api.conversations.claimSteeringMessages, { deviceToken, threadId })).toEqual([
    { content: "first steer" },
    { content: "second steer" },
  ]);
  expect((await owner.query(api.conversations.listThreadMessages, { threadId })).filter((message) => message.role === "user").map(({ content, status }) => ({ content, status }))).toEqual([
    { content: "start", status: "complete" },
    { content: "first steer", status: "complete" },
    { content: "second steer", status: "complete" },
  ]);
});

test("Stop is acknowledged independently and a late queued message schedules the next turn", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "stop" });
  await owner.mutation(api.conversations.sendUserMessage, { content: "start", threadId });
  await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });
  const staleAssistantId = await t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId });
  const assistantId = await t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId });

  await expect(t.mutation(api.conversations.acknowledgeStop, { deviceToken, messageId: assistantId, threadId })).rejects.toThrow("Stop was not requested");
  await owner.mutation(api.conversations.requestStop, { threadId });
  await expect(t.mutation(api.conversations.acknowledgeStop, { deviceToken, messageId: staleAssistantId, threadId })).rejects.toThrow("active turn");
  expect(await t.query(api.conversations.getStopState, { deviceToken, threadId })).toEqual({ requested: true });
  await t.mutation(api.conversations.acknowledgeStop, { deviceToken, messageId: assistantId, threadId });
  expect((await t.run((ctx) => ctx.db.get("threads", threadId)))?.status).toBe("stopped");
  expect(await t.query(api.conversations.getStopState, { deviceToken, threadId })).toEqual({ requested: false });

  await owner.mutation(api.conversations.sendUserMessage, { content: "resume", threadId });
  expect((await t.run((ctx) => ctx.db.get("threads", threadId)))?.status).toBe("queued");

  await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });
  const nextAssistantId = await t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId });
  await owner.mutation(api.conversations.sendUserMessage, { content: "late steer", threadId });
  await t.mutation(api.conversations.completeAssistantMessage, { deviceToken, messageId: nextAssistantId, status: "done", threadId });
  expect((await t.run((ctx) => ctx.db.get("threads", threadId)))?.status).toBe("queued");
  expect(await t.mutation(api.conversations.claimQueuedMessage, { deviceToken })).toMatchObject({ content: "late steer", threadId });
});

test("Stop preserves a concurrently queued steer for the next turn", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "stop queue race" });
  await owner.mutation(api.conversations.sendUserMessage, { content: "start", threadId });
  await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });
  const assistantId = await t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId });
  await owner.mutation(api.conversations.sendUserMessage, { content: "keep this", threadId });
  await owner.mutation(api.conversations.requestStop, { threadId });

  expect(await t.mutation(api.conversations.claimSteeringMessages, { deviceToken, threadId })).toEqual([]);
  await t.mutation(api.conversations.acknowledgeStop, { deviceToken, messageId: assistantId, threadId });

  expect((await t.run((ctx) => ctx.db.get("threads", threadId)))?.status).toBe("queued");
  expect((await owner.query(api.conversations.listThreadMessages, { threadId })).find((message) => message.content === "keep this")?.status).toBe("queued");
});

test("a Stop racing normal completion wins atomically and clears its flag", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "stop race" });
  await owner.mutation(api.conversations.sendUserMessage, { content: "start", threadId });
  await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });
  const assistantId = await t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId });
  await owner.mutation(api.conversations.requestStop, { threadId });

  await t.mutation(api.conversations.completeAssistantMessage, { deviceToken, messageId: assistantId, status: "done", threadId });

  expect(await t.run((ctx) => ctx.db.get("threads", threadId))).toMatchObject({ status: "stopped", stopRequested: false });
});
