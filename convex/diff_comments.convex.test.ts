/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

test("claimed review comments resolve when their assistant turn completes", async () => {
  const t = convexTest(schema, modules);
  const projectId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", {
      daemonVersion: "test",
      deviceToken: "device-token",
      lastHeartbeatAt: Date.now(),
      name: "test-machine",
      platform: "linux",
    });
    return ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
  });
  const threadId = await t.mutation(api.conversations.createThread, { projectId, title: "review" });
  const commentId = await t.mutation(api.diff_comments.create, {
    content: "Handle the empty case.",
    endLine: 14,
    filePath: "src/parser.ts",
    startLine: 12,
    threadId,
  });
  await t.mutation(api.conversations.sendUserMessage, { content: "Address feedback.", threadId });

  const queued = await t.mutation(api.conversations.claimQueuedMessage, { deviceToken: "device-token" });
  expect(queued?.reviewComments).toEqual([{
    commentId,
    content: "Handle the empty case.",
    endLine: 14,
    filePath: "src/parser.ts",
    startLine: 12,
  }]);

  const messageId = await t.mutation(api.conversations.beginAssistantMessage, { threadId });
  await t.mutation(api.conversations.completeAssistantMessage, { messageId, resolvedCommentIds: [commentId], status: "done", threadId });
  const comments = await t.query(api.diff_comments.listForThread, { threadId });
  expect(comments).toMatchObject([{ _id: commentId, resolved: true }]);

  const failedCommentId = await t.mutation(api.diff_comments.create, {
    content: "Keep this pending.",
    endLine: 20,
    filePath: "src/parser.ts",
    startLine: 20,
    threadId,
  });
  const failedMessageId = await t.mutation(api.conversations.beginAssistantMessage, { threadId });
  await t.mutation(api.conversations.completeAssistantMessage, { messageId: failedMessageId, resolvedCommentIds: [failedCommentId], status: "failed", threadId });
  const commentsAfterFailure = await t.query(api.diff_comments.listForThread, { threadId });
  expect(commentsAfterFailure.find((comment) => comment._id === failedCommentId)?.resolved).toBe(false);
});
