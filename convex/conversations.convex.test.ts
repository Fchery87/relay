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

test("creates threads with a permission profile, defaulting to workspace-write", async () => {
  const t = convexTest(schema, modules);
  const { owner, projectId } = await createAuthenticatedProject(t);

  const defaultedId = await owner.mutation(api.conversations.createThread, { projectId, title: "defaulted" });
  const explicitId = await owner.mutation(api.conversations.createThread, { permissionProfile: "read-only", projectId, title: "explicit" });

  const threads = await owner.query(api.conversations.listProjectThreads, { projectId });
  expect(threads.find((thread) => thread._id === defaultedId)?.permissionProfile).toBe("workspace-write");
  expect(threads.find((thread) => thread._id === explicitId)?.permissionProfile).toBe("read-only");
});

test("permission profile is editable while idle and locked mid-turn", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);

  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "profile" });
  await owner.mutation(api.conversations.updatePermissionProfile, { permissionProfile: "full-access", threadId });
  let threads = await owner.query(api.conversations.listProjectThreads, { projectId });
  expect(threads.find((thread) => thread._id === threadId)?.permissionProfile).toBe("full-access");

  await owner.mutation(api.conversations.sendUserMessage, { content: "go", threadId });
  await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });
  await t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId });
  await expect(
    owner.mutation(api.conversations.updatePermissionProfile, { permissionProfile: "read-only", threadId }),
  ).rejects.toThrow("while a turn is executing");
});

test("claimQueuedMessage returns the thread permission profile", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { permissionProfile: "full-access", projectId, status: "idle", title: "yolo" }));
  await t.run((ctx) => ctx.db.insert("messages", { content: "go", role: "user", status: "queued", threadId }));
  const claimed = await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });
  expect(claimed).toMatchObject({ permissionProfile: "full-access", threadId });
});

test("claimQueuedMessage defaults permission profile to workspace-write", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "idle", title: "default" }));
  await t.run((ctx) => ctx.db.insert("messages", { content: "go", role: "user", status: "queued", threadId }));
  expect(await t.mutation(api.conversations.claimQueuedMessage, { deviceToken })).toMatchObject({ permissionProfile: "workspace-write" });
});
