import { expect, test } from "bun:test";
import type { DurableEffect } from "@relay/contracts";
import { openMemoryStore, DurableTaskStore } from "@relay/local-store";
import { OrchestrationEngine } from "./orchestration-engine";
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

test("workflow start is accepted by the engine and persists a child effect", async () => {
  const db = openMemoryStore();
  const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 1, reactors: createWorkflowReactors(db) });
  const run = await engine.createRun({ projectId: "project-1" });
  const task = { taskId: "engine-child" as never, runId: run.runId, role: "builder" as const, objective: "engine task", dependencies: [], capabilityCeiling: "workspace-write", contextBudget: 100, workspaceMode: "shared-read" as const, state: "ready" as const, attempt: 0, maxAttempts: 1 };
  await engine.submit({ commandId: "workflow-command" as never, type: "workflow.start", runId: run.runId, correlationId: "workflow-correlation" as never, actor: { kind: "system", id: "test" }, issuedAt: 1, payload: { workflowKind: "test", task } });
  expect(await engine.drainEffects()).toBe(1);
  expect(new DurableTaskStore(db).get(task.taskId)?.objective).toBe("engine task");
  await engine.close();
  db.close();
});

test("configured workflow executor claims and completes the child through the task lease", async () => {
  const db = openMemoryStore();
  let executions = 0;
  const reactors = createWorkflowReactors(db, {
    executeChild: async ({ task, context }) => {
      executions++;
      expect(context.signal.aborted).toBe(false);
      expect(task.objective).toBe("execute me");
      return { commands: [] };
    },
  });
  const effect = {
    effectId: "effect-execute" as never,
    idempotencyKey: "effect-execute" as never,
    runId: "run-1" as never,
    commandId: "command-execute" as never,
    effectIndex: 0,
    intent: { kind: "workflow.create_child", workflowKind: "subagent", input: { taskId: "child-execute", runId: "run-1", role: "builder", objective: "execute me", dependencies: [], capabilityCeiling: "workspace-write", contextBudget: 100, workspaceMode: "shared-read", state: "ready", attempt: 0, maxAttempts: 1 } },
    status: "running",
    attempts: 1,
    retryClass: "transient",
    nextAttemptAt: 0,
  } satisfies DurableEffect;
  await reactors["workflow.create_child"]!.execute(effect, { idempotencyKey: effect.effectId, signal: new AbortController().signal });
  expect(executions).toBe(1);
  expect(new DurableTaskStore(db).get("child-execute" as never)?.state).toBe("completed");
  db.close();
});
