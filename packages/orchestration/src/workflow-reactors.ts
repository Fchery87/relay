import type { DurableEffect, EffectReactor, ReactorRegistry, TaskSpec } from "@relay/contracts";
import { DurableTaskStore, type StoreDatabase } from "@relay/local-store";

/** Default durable implementations for workflow effects emitted by adapters. */
export function createWorkflowReactors(db: StoreDatabase): ReactorRegistry {
  const tasks = new DurableTaskStore(db);
  const createChild: EffectReactor = {
    execute: async (effect) => {
      if (effect.intent.kind !== "workflow.create_child") throw new Error("Unexpected workflow effect");
      tasks.put(toTaskSpec(effect), Date.now());
      return [];
    },
    recover: async (effect) => {
      if (effect.intent.kind !== "workflow.create_child") throw new Error("Unexpected workflow effect");
      tasks.put(toTaskSpec(effect), Date.now());
      return [];
    },
  };
  const completeChild: EffectReactor = {
    execute: async (effect) => {
      if (effect.intent.kind !== "workflow.complete_child") throw new Error("Unexpected workflow effect");
      tasks.cancel(effect.intent.childId as never, effect.intent.result);
      return [];
    },
    recover: async (effect) => {
      if (effect.intent.kind !== "workflow.complete_child") throw new Error("Unexpected workflow effect");
      tasks.cancel(effect.intent.childId as never, effect.intent.result);
      return [];
    },
  };
  return {
    "workflow.create_child": createChild,
    "workflow.complete_child": completeChild,
  };
}

function toTaskSpec(effect: DurableEffect): TaskSpec {
  if (effect.intent.kind !== "workflow.create_child") throw new Error("Unexpected workflow effect");
  const input = effect.intent.input;
  if (isTaskSpec(input)) {
    if (input.runId !== effect.runId) throw new Error("Child task run ownership mismatch");
    return input;
  }
  if (!isFollowUpInput(input)) throw new Error("workflow.create_child requires a TaskSpec or follow-up input");
  return {
    taskId: input.taskId as never,
    runId: effect.runId,
    role: "builder",
    objective: input.text,
    dependencies: [],
    capabilityCeiling: "workspace-write",
    contextBudget: 8_000,
    workspaceMode: "isolated-worktree",
    state: "ready",
    attempt: 0,
    maxAttempts: 3,
    workflowKind: effect.intent.workflowKind,
  };
}

function isTaskSpec(value: unknown): value is TaskSpec {
  return typeof value === "object" && value !== null && "taskId" in value && "runId" in value && "role" in value && "objective" in value && "state" in value;
}

function isFollowUpInput(value: unknown): value is { readonly taskId: string; readonly text: string } {
  return typeof value === "object" && value !== null && typeof (value as { taskId?: unknown }).taskId === "string" && typeof (value as { text?: unknown }).text === "string";
}
