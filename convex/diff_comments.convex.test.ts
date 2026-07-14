/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

test("claimed review comments resolve when their assistant turn completes", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "review" });
  const commentId = await owner.mutation(api.diff_comments.create, {
    content: "Handle the empty case.",
    endLine: 14,
    filePath: "src/parser.ts",
    startLine: 12,
    threadId,
  });
  await owner.mutation(api.conversations.sendUserMessage, { content: "Address feedback.", threadId });

  const queued = await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });
  expect(queued?.reviewComments).toEqual([{
    commentId,
    content: "Handle the empty case.",
    endLine: 14,
    filePath: "src/parser.ts",
    startLine: 12,
  }]);

  const messageId = await t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId });
  await t.mutation(api.conversations.completeAssistantMessage, { deviceToken, messageId, resolvedCommentIds: [commentId], status: "done", threadId });
  const comments = await owner.query(api.diff_comments.listForThread, { threadId });
  expect(comments).toMatchObject([{ _id: commentId, resolved: true }]);

  const failedCommentId = await owner.mutation(api.diff_comments.create, {
    content: "Keep this pending.",
    endLine: 20,
    filePath: "src/parser.ts",
    startLine: 20,
    threadId,
  });
  const failedMessageId = await t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId });
  await t.mutation(api.conversations.completeAssistantMessage, { deviceToken, messageId: failedMessageId, resolvedCommentIds: [failedCommentId], status: "failed", threadId });
  const commentsAfterFailure = await owner.query(api.diff_comments.listForThread, { threadId });
  expect(commentsAfterFailure.find((comment) => comment._id === failedCommentId)?.resolved).toBe(false);
});
