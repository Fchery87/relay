/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";

const modules = import.meta.glob("./**/*.ts");

test("records checkpoints and machine-scopes queued restores", async () => {
  const t = convexTest(schema, modules);
  const { checkpointThreadId, deviceToken, messageId, otherThreadId } = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { daemonVersion: "test", deviceToken: "device-a", lastHeartbeatAt: Date.now(), name: "machine-a", platform: "linux" });
    const otherMachineId = await ctx.db.insert("machines", { daemonVersion: "test", deviceToken: "device-b", lastHeartbeatAt: Date.now(), name: "machine-b", platform: "linux" });
    const projectId = await ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
    const otherProjectId = await ctx.db.insert("projects", { machineId: otherMachineId, name: "other", path: "/other" });
    const checkpointThreadId = await ctx.db.insert("threads", { projectId, status: "idle", title: "checkpoint" });
    const otherThreadId = await ctx.db.insert("threads", { projectId: otherProjectId, status: "idle", title: "other" });
    const messageId = await ctx.db.insert("messages", { content: "done", role: "assistant", status: "complete", threadId: checkpointThreadId });
    return { checkpointThreadId, deviceToken: "device-a", messageId, otherThreadId };
  });

  const checkpointId = await t.mutation(api.checkpoints.record, {
    commit: "abc123",
    deviceToken,
    messageId,
    ref: `refs/relay/checkpoints/${checkpointThreadId}/${messageId}`,
    threadId: checkpointThreadId,
  });
  expect(await t.query(api.checkpoints.listForThread, { threadId: checkpointThreadId })).toMatchObject([
    { _id: checkpointId, commit: "abc123", messageId },
  ]);
  const secondMessageId = await t.run((ctx) => ctx.db.insert("messages", { content: "later", role: "assistant", status: "complete", threadId: checkpointThreadId }));
  const secondCheckpointId = await t.mutation(api.checkpoints.record, {
    commit: "def456",
    deviceToken,
    messageId: secondMessageId,
    ref: `refs/relay/checkpoints/${checkpointThreadId}/${secondMessageId}`,
    threadId: checkpointThreadId,
  });
  const comparisonId = await t.mutation(api.checkpoints.enqueueComparison, { fromCheckpointId: checkpointId, threadId: checkpointThreadId, toCheckpointId: secondCheckpointId });
  const firstComparisonClaim = await t.mutation(api.checkpoints.claimComparison, { deviceToken });
  expect(firstComparisonClaim).toMatchObject({ comparisonId, fromCommit: "abc123", toCommit: "def456" });
  await t.run(async (ctx) => ctx.db.patch(comparisonId, { leaseExpiresAt: 0 }));
  const secondComparisonClaim = await t.mutation(api.checkpoints.claimComparison, { deviceToken });
  expect(secondComparisonClaim?.claimToken).not.toBe(firstComparisonClaim?.claimToken);
  await expect(t.mutation(api.checkpoints.completeComparison, { claimToken: firstComparisonClaim!.claimToken, comparisonId, content: "stale", deviceToken, status: "complete" })).rejects.toThrow("lease");
  await t.mutation(api.checkpoints.completeComparison, { claimToken: secondComparisonClaim!.claimToken, comparisonId, content: "patch", deviceToken, status: "complete" });
  expect(await t.query(api.checkpoints.latestComparison, { threadId: checkpointThreadId })).toMatchObject({ content: "patch", status: "complete" });
  await expect(t.mutation(api.checkpoints.enqueueRestore, { checkpointId, threadId: otherThreadId })).rejects.toThrow("Checkpoint does not belong to thread");

  const actionId = await t.mutation(api.checkpoints.enqueueRestore, { checkpointId, threadId: checkpointThreadId });
  expect((await t.run((ctx) => ctx.db.get("threads", checkpointThreadId)))?.status).toBe("restoring");
  await t.mutation(api.conversations.sendUserMessage, { content: "wait until restore finishes", threadId: checkpointThreadId });
  expect((await t.run((ctx) => ctx.db.get("threads", checkpointThreadId)))?.status).toBe("restoring");
  expect(await t.mutation(api.conversations.claimQueuedMessage, { deviceToken })).toBeNull();
  await expect(t.mutation(api.commands.enqueue, { command: "touch race.txt", threadId: checkpointThreadId })).rejects.toThrow("restore");
  await expect(t.mutation(api.git_actions.enqueue, { action: "stage", threadId: checkpointThreadId })).rejects.toThrow("restore");
  expect(await t.mutation(api.checkpoints.claimRestore, { deviceToken: "device-b" })).toBeNull();
  const firstRestoreClaim = await t.mutation(api.checkpoints.claimRestore, { deviceToken });
  expect(firstRestoreClaim).toMatchObject({ actionId, checkpointId, commit: "abc123", projectPath: "/repo", threadId: checkpointThreadId });
  await t.run(async (ctx) => ctx.db.patch(actionId, { leaseExpiresAt: 0 }));
  const secondRestoreClaim = await t.mutation(api.checkpoints.claimRestore, { deviceToken });
  expect(secondRestoreClaim).toMatchObject({ actionId });
  expect(secondRestoreClaim?.claimToken).not.toBe(firstRestoreClaim?.claimToken);
  await expect(t.mutation(api.checkpoints.completeRestore, { actionId, claimToken: firstRestoreClaim!.claimToken, deviceToken, status: "complete" })).rejects.toThrow("lease");
  expect((await t.run((ctx) => ctx.db.get("threads", checkpointThreadId)))?.status).toBe("restoring");
  await expect(t.mutation(api.checkpoints.completeRestore, { actionId, claimToken: secondRestoreClaim!.claimToken, deviceToken: "device-b", status: "complete" })).rejects.toThrow("machine");
  await t.mutation(api.checkpoints.completeRestore, { actionId, claimToken: secondRestoreClaim!.claimToken, deviceToken, status: "complete" });
  expect((await t.run((ctx) => ctx.db.get("threads", checkpointThreadId)))?.status).toBe("queued");

  expect(await t.query(api.events.list, { threadId: checkpointThreadId })).toMatchObject([
    { checkpointId, kind: "checkpoint.reverted" },
  ]);

  await t.mutation(api.conversations.removeThread, { threadId: checkpointThreadId });
  expect(await t.run((ctx) => ctx.db.query("checkpoints").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("checkpointActions").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("checkpointComparisons").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("events").collect())).toEqual([]);
});
