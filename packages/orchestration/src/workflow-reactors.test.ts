import { expect, test } from "bun:test";
import type { DurableEffect } from "@relay/contracts";
import { openMemoryStore, DurableTaskStore } from "@relay/local-store";
import { createWorkflowReactors } from "./workflow-reactors";

test("workflow reactors create a durable child idempotently", async () => {
  const db = openMemoryStore();
  const reactors = createWorkflowReactors(db);
  const effect = {
    effectId: "effect-child" as never,
    idempotencyKey: "effect-child" as never,
    runId: "run-1" as never,
    commandId: "command-1" as never,
    effectIndex: 0,
    intent: { kind: "workflow.create_child", workflowKind: "follow-up", input: { taskId: "child-1", text: "continue" } },
    status: "running",
    attempts: 1,
    retryClass: "transient",
    nextAttemptAt: 0,
  } satisfies DurableEffect;
  await reactors["workflow.create_child"]!.execute(effect, { idempotencyKey: effect.effectId, signal: new AbortController().signal });
  await reactors["workflow.create_child"]!.recover(effect, { idempotencyKey: effect.effectId, signal: new AbortController().signal });
  expect(new DurableTaskStore(db).get("child-1" as never)).toMatchObject({ runId: "run-1", objective: "continue", workflowKind: "follow-up" });
  db.close();
});

test("workflow completion reactor cancels a live child", async () => {
  const db = openMemoryStore();
  const store = new DurableTaskStore(db);
  store.put({ taskId: "child-2" as never, runId: "run-1" as never, role: "builder", objective: "cancel me", dependencies: [], capabilityCeiling: "workspace-write", contextBudget: 100, workspaceMode: "shared-read", state: "ready", attempt: 0, maxAttempts: 1 });
  const reactors = createWorkflowReactors(db);
  const effect = {
    effectId: "effect-cancel" as never,
    idempotencyKey: "effect-cancel" as never,
    runId: "run-1" as never,
    commandId: "command-2" as never,
    effectIndex: 0,
    intent: { kind: "workflow.complete_child", childId: "child-2", result: { cancelled: true } },
    status: "running",
    attempts: 1,
    retryClass: "transient",
    nextAttemptAt: 0,
  } satisfies DurableEffect;
  await reactors["workflow.complete_child"]!.execute(effect, { idempotencyKey: effect.effectId, signal: new AbortController().signal });
  expect(store.get("child-2" as never)?.state).toBe("cancelled");
  db.close();
});
