import type { DurableEffect, EffectReactor, ReactorCommandDraft, ReactorContext, ReactorRegistry, TaskSpec } from "@relay/contracts";
import { DurableTaskStore, type StoreDatabase } from "@relay/local-store";

export type WorkflowChildExecutor = (input: {
  readonly effect: DurableEffect;
  readonly task: TaskSpec;
  readonly context: ReactorContext;
}) => Promise<WorkflowChildExecution>;

export type WorkflowChildExecution = {
  readonly commands: ReadonlyArray<ReactorCommandDraft>;
  readonly result?: unknown;
};

/** Default durable implementations for workflow effects emitted by adapters. */
export function createWorkflowReactors(db: StoreDatabase, options?: { readonly executeChild?: WorkflowChildExecutor }): ReactorRegistry {
  const tasks = new DurableTaskStore(db);
  const createChild: EffectReactor = {
    execute: async (effect, context) => {
      if (effect.intent.kind !== "workflow.create_child") throw new Error("Unexpected workflow effect");
      return (await executeChild(effect, tasks, options?.executeChild, context)).commands;
    },
    recover: async (effect, context) => {
      if (effect.intent.kind !== "workflow.create_child") throw new Error("Unexpected workflow effect");
      return (await executeChild(effect, tasks, options?.executeChild, context)).commands;
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

async function executeChild(
  effect: DurableEffect,
  tasks: DurableTaskStore,
  executor: WorkflowChildExecutor | undefined,
  context: ReactorContext,
): Promise<WorkflowChildExecution> {
  const task = toTaskSpec(effect);
  const existing = tasks.get(task.taskId);
  tasks.put(task, Date.now());
  if (!executor) return { commands: [] };
  if (existing?.state === "completed") return { commands: [] };
  const owner = `workflow-${effect.effectId}`;
  const generation = tasks.claim(task.taskId, owner, 10 * 60 * 1000, Date.now());
  try {
    const execution = await executor({ effect, task, context });
    if (!tasks.complete(task.taskId, owner, generation, execution.result ?? { completed: true }, Date.now())) {
      throw new Error(`Child task completion was fenced: ${task.taskId}`);
    }
    return execution;
  } catch (error) {
    tasks.fail(task.taskId, owner, generation, error instanceof Error ? error.message : String(error), Date.now());
    throw error;
  }
}

function isTaskSpec(value: unknown): value is TaskSpec {
  return typeof value === "object" && value !== null && "taskId" in value && "runId" in value && "role" in value && "objective" in value && "state" in value;
}

function isFollowUpInput(value: unknown): value is { readonly taskId: string; readonly text: string } {
  return typeof value === "object" && value !== null && typeof (value as { taskId?: unknown }).taskId === "string" && typeof (value as { text?: unknown }).text === "string";
}
