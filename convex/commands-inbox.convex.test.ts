/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

test("canonical run creation creates an owned thread and inbox command atomically", async () => {
  const t = convexTest(schema, modules);
  const { owner, projectId } = await createAuthenticatedProject(t);
  const input = {
    commandId: "cmd-canonical-run-create",
    correlationId: "corr-canonical-run-create",
    mode: "plan" as const,
    projectId,
    title: "Canonical plan",
  };

  const threadId = await owner.mutation(api.commands.inbox.createRun, input);
  const retryThreadId = await owner.mutation(api.commands.inbox.createRun, input);
  expect(retryThreadId).toBe(threadId);

  const state = await t.run(async (ctx) => ({
    command: await ctx.db.query("commandInbox").withIndex("by_command_id", (q) => q.eq("commandId", input.commandId)).unique(),
    thread: await ctx.db.get(threadId),
  }));
  expect(state.thread).toMatchObject({ mode: "plan", projectId, status: "idle", title: "Canonical plan" });
  expect(state.command).toMatchObject({ kind: "run.create", runId: threadId, status: "pending", threadId });
  expect(JSON.parse(state.command!.payloadJson)).toEqual({ mode: "plan", projectId, title: "Canonical plan" });
});

test("canonical tool workspace hints must match the authorized project path", async () => {
  const t = convexTest(schema, modules);
  const { owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "running", title: "kernel tool" }));

  await expect(owner.mutation(api.commands.inbox.submitToInbox, {
    commandId: "cmd-unsafe-project-path",
    correlationId: "corr-unsafe-project-path",
    kind: "turn.send",
    payloadJson: JSON.stringify({ projectPath: "/other-repository", prompt: "read a file", turnId: "turn-1" }),
    runId: threadId,
    threadId,
  })).rejects.toThrow(/projectPath must match the authorized project/);
});

test("claimed commands carry the authorized project path for daemon workspace resolution", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "running", title: "kernel tool" }));

  await owner.mutation(api.commands.inbox.submitToInbox, {
    commandId: "cmd-authorized-project-path",
    correlationId: "corr-authorized-project-path",
    kind: "run.create",
    payloadJson: JSON.stringify({ projectId }),
    threadId,
  });

  const claimed = await t.mutation(api.commands.inbox.claimBatch, { deviceToken, leaseDurationMs: 30_000, limit: 5 });
  expect(claimed).toHaveLength(1);
  expect(claimed[0]).toMatchObject({ projectPath: "/repo" });
});

test("command ingress records an owner-scoped audit trail with correlation identity", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "running", title: "audited command" }));

  await owner.mutation(api.commands.inbox.submitToInbox, {
    commandId: "cmd-audited",
    correlationId: "corr-audited",
    kind: "turn.send",
    payloadJson: JSON.stringify({ prompt: "audit me", turnId: "turn-audited" }),
    runId: threadId,
    threadId,
  });
  const claimed = await t.mutation(api.commands.inbox.claimBatch, { deviceToken, leaseDurationMs: 30_000, limit: 1 });
  await t.mutation(api.commands.inbox.completeInbox, { commandId: claimed[0]!._id, deviceToken, leaseGeneration: claimed[0]!.leaseGeneration, status: "completed" });

  const audits = await owner.query(api.audit_log.listForThread, { threadId });
  expect(audits.map((audit) => audit.action)).toEqual(["command.accepted", "command.claimed", "command.completed"]);
  expect(audits[0]).toMatchObject({ actorKind: "user", category: "command", correlationId: "corr-audited", effectiveScope: "/repo", policyVersion: "command-ingress-v1", requestedScope: "/repo" });
  expect(audits[2]).toMatchObject({ action: "command.completed", category: "command", effectiveScope: "/repo", requestedScope: "/repo", threadId });
});

test("command ingress rejects another owner's thread", async () => {
  const t = convexTest(schema, modules);
  const { projectId } = await createAuthenticatedProject(t, "f".repeat(32));
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "running", title: "private thread" }));
  const strangerId = await t.run((ctx) => ctx.db.insert("users", {}));
  const stranger = t.withIdentity({ subject: `${strangerId}|session` });

  await expect(stranger.mutation(api.commands.inbox.submitToInbox, {
    commandId: "cmd-cross-owner",
    correlationId: "corr-cross-owner",
    kind: "turn.send",
    payloadJson: JSON.stringify({ prompt: "steal this run", turnId: "turn-cross-owner" }),
    runId: threadId,
    threadId,
  })).rejects.toThrow(/does not belong to the current user/);
});
