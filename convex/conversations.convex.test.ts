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

test("queued messages carry machine ownership for bounded daemon claims", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, machineId, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "indexed queue" });

  await owner.mutation(api.conversations.sendUserMessage, { content: "hello", threadId });
  const message = await t.run((ctx) => ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", threadId)).first());
  expect(message).toMatchObject({ machineId, status: "queued" });
});

test("machine-scoped claims do not scan past another machine's queued backlog", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, machineId, owner, projectId, userId } = await createAuthenticatedProject(t);
  const otherMachineId = await t.run((ctx) => ctx.db.insert("machines", {
    daemonVersion: "test",
    deviceTokenHash: "other-device-hash",
    lastHeartbeatAt: Date.now(),
    name: "other-machine",
    ownerId: userId,
    platform: "linux",
  }));
  const otherProjectId = await t.run((ctx) => ctx.db.insert("projects", { machineId: otherMachineId, name: "other", path: "/other" }));
  const otherThreadId = await t.run((ctx) => ctx.db.insert("threads", { projectId: otherProjectId, status: "idle", title: "other" }));
  await t.run(async (ctx) => {
    for (let index = 0; index < 30; index++) {
      await ctx.db.insert("messages", { content: `other-${index}`, machineId: otherMachineId, queuedThreadId: otherThreadId, role: "user", status: "queued", threadId: otherThreadId });
    }
  });

  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "mine" });
  await owner.mutation(api.conversations.sendUserMessage, { content: "mine", threadId });

  expect(await t.mutation(api.conversations.claimQueuedMessage, { deviceToken })).toMatchObject({ content: "mine", threadId, projectId });
});

test("thread message history is bounded for the legacy document query", async () => {
  const t = convexTest(schema, modules);
  const { owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "large history" });
  await t.run(async (ctx) => {
    for (let index = 0; index < 205; index++) {
      await ctx.db.insert("messages", { content: `message-${index}`, role: "assistant", status: "complete", threadId });
    }
  });

  expect(await owner.query(api.conversations.listThreadMessages, { threadId })).toHaveLength(200);
});

test("worktree GC resolves only its locally tracked thread ids", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, projectId } = await createAuthenticatedProject(t);
  const retainedThreadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "idle", title: "retained" }));
  await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "idle", title: "not-local" }));

  expect(await t.query(api.conversations.listThreadIds, { candidateThreadIds: [retainedThreadId], deviceToken })).toEqual([retainedThreadId]);
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
