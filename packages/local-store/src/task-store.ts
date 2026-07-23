import type { TaskId, TaskSpec } from "@relay/contracts";
import type { StoreDatabase } from "./database";

export type TaskClaim = {
  readonly task: TaskSpec;
  readonly generation: number;
};

export class DurableTaskStore {
  constructor(private readonly db: StoreDatabase) {}

  /** Insert a task exactly once; retries cannot overwrite a live task lease. */
  put(task: TaskSpec, now = Date.now()): void {
    this.db.run(
      "INSERT OR IGNORE INTO durable_tasks(task_id,run_id,parent_task_id,state,payload_json,attempt,updated_at) VALUES(?,?,?,?,?,?,?)",
      [
        task.taskId as string,
        task.runId as string,
        (task.parentTaskId as string | undefined) ?? null,
        task.state,
        JSON.stringify(task),
        task.attempt,
        now,
      ],
    );
    const existing = this.get(task.taskId);
    if (!existing) throw new Error(`Task ${task.taskId} was not persisted`);
    if (!sameTaskIdentity(existing, task)) {
      throw new Error(`Task ${task.taskId} already exists with different immutable fields`);
    }
  }

  get(taskId: TaskId): TaskSpec | undefined {
    const row = this.db
      .query("SELECT payload_json FROM durable_tasks WHERE task_id=?")
      .get(taskId as string) as { payload_json: string } | null;
    return row ? (JSON.parse(row.payload_json) as TaskSpec) : undefined;
  }

  list(input?: { readonly runId?: string; readonly states?: readonly TaskSpec["state"][] }): readonly TaskSpec[] {
    const rows = this.db
      .query(
        input?.runId
          ? "SELECT payload_json FROM durable_tasks WHERE run_id=? ORDER BY updated_at, task_id"
          : "SELECT payload_json FROM durable_tasks ORDER BY updated_at, task_id",
      )
      .all(...(input?.runId ? [input.runId] : [])) as Array<{ payload_json: string }>;
    const states = input?.states ? new Set(input.states) : undefined;
    return rows
      .map((row) => JSON.parse(row.payload_json) as TaskSpec)
      .filter((task) => !states || states.has(task.state));
  }

  frontier(runId: string, limit = 4): readonly TaskSpec[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid task frontier limit");
    const tasks = this.list({ runId });
    const completed = new Set(tasks.filter((task) => task.state === "completed").map((task) => task.taskId));
    return tasks
      .filter((task) =>
        (task.state === "pending" || task.state === "ready") &&
        task.dependencies.every((dependency) => completed.has(dependency)),
      )
      .slice(0, limit);
  }

  /** Claim pending work, or reclaim a running task whose lease has expired. */
  claim(taskId: TaskId, owner: string, leaseMs: number, now = Date.now()): number {
    if (!owner || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("Invalid task lease");
    }
    const row = this.db
      .query("SELECT lease_generation,state,lease_expires_at,attempt FROM durable_tasks WHERE task_id=?")
      .get(taskId as string) as { lease_generation: number; state: string; lease_expires_at: number | null; attempt: number } | null;
    if (
      !row ||
      (!["pending", "ready"].includes(row.state) &&
        !(row.state === "failed" && row.attempt < (this.get(taskId)?.maxAttempts ?? 0)) &&
        !(row.state === "running" && row.lease_expires_at !== null && row.lease_expires_at <= now))
    ) {
      throw new Error("Task is not claimable");
    }
    const generation = row.lease_generation + 1;
    const task = this.get(taskId);
    if (!task) throw new Error("Task is not claimable");
    this.db.run(
      "UPDATE durable_tasks SET state='running',payload_json=?,lease_owner=?,lease_expires_at=?,lease_generation=?,attempt=attempt+1,updated_at=? WHERE task_id=? AND lease_generation=?",
      [JSON.stringify({ ...task, state: "running", attempt: task.attempt + 1 }), owner, now + leaseMs, generation, now, taskId as string, row.lease_generation],
    );
    const claimed = this.db
      .query("SELECT lease_generation,state FROM durable_tasks WHERE task_id=?")
      .get(taskId as string) as { lease_generation: number; state: string } | null;
    if (!claimed || claimed.lease_generation !== generation || claimed.state !== "running") {
      throw new Error("Task claim lost");
    }
    return generation;
  }

  complete(
    taskId: TaskId,
    owner: string,
    generation: number,
    result: unknown,
    now = Date.now(),
  ): boolean {
    return this.transition(taskId, "completed", { owner, generation, result, now });
  }

  fail(
    taskId: TaskId,
    owner: string,
    generation: number,
    error: string,
    now = Date.now(),
  ): boolean {
    return this.transition(taskId, "failed", { owner, generation, error, now });
  }

  cancel(taskId: TaskId, result: unknown = { cancelled: true }, now = Date.now()): boolean {
    const task = this.get(taskId);
    if (!task || ["completed", "failed", "cancelled"].includes(task.state)) return false;
    return this.writeTask({ ...task, state: "cancelled", result }, now, {
      clearLease: true,
    });
  }

  /** Return expired running tasks to the ready frontier. */
  reclaimExpired(now = Date.now()): number {
    const tasks = this.list({ states: ["running"] });
    let reclaimed = 0;
    for (const task of tasks) {
      const row = this.db
        .query("SELECT lease_expires_at FROM durable_tasks WHERE task_id=?")
        .get(task.taskId as string) as { lease_expires_at: number | null } | null;
      if (row?.lease_expires_at !== null && row?.lease_expires_at !== undefined && row.lease_expires_at <= now) {
        this.writeTask({ ...task, state: "ready" }, now, { clearLease: true });
        reclaimed++;
      }
    }
    return reclaimed;
  }

  private transition(
    taskId: TaskId,
    state: Extract<TaskSpec["state"], "completed" | "failed">,
    input: { readonly owner: string; readonly generation: number; readonly result?: unknown; readonly error?: string; readonly now: number },
  ): boolean {
    const task = this.get(taskId);
    if (!task) return false;
    const row = this.db
      .query("SELECT lease_owner,lease_generation,state FROM durable_tasks WHERE task_id=?")
      .get(taskId as string) as { lease_owner: string | null; lease_generation: number; state: string } | null;
    if (!row || row.state !== "running" || row.lease_owner !== input.owner || row.lease_generation !== input.generation) return false;
    return this.writeTask({ ...task, state, ...(input.result === undefined ? {} : { result: input.result }), ...(input.error === undefined ? {} : { error: input.error }) }, input.now, { clearLease: true });
  }

  private writeTask(task: TaskSpec, now: number, options: { readonly clearLease: boolean }): boolean {
    this.db.run(
      `UPDATE durable_tasks SET state=?,payload_json=?,lease_owner=${options.clearLease ? "NULL" : "lease_owner"},lease_expires_at=${options.clearLease ? "NULL" : "lease_expires_at"},updated_at=? WHERE task_id=?`,
      [task.state, JSON.stringify(task), now, task.taskId as string],
    );
    return true;
  }
}

function sameTaskIdentity(left: TaskSpec, right: TaskSpec): boolean {
  return JSON.stringify({
    taskId: left.taskId,
    parentTaskId: left.parentTaskId,
    runId: left.runId,
    role: left.role,
    objective: left.objective,
    dependencies: left.dependencies,
    capabilityCeiling: left.capabilityCeiling,
    contextBudget: left.contextBudget,
    workspaceMode: left.workspaceMode,
    providerInstanceId: left.providerInstanceId,
    maxAttempts: left.maxAttempts,
    workflowKind: left.workflowKind,
    roleName: left.roleName,
    capabilities: left.capabilities,
    projectPath: left.projectPath,
    threadId: left.threadId,
    turnId: left.turnId,
    modelId: left.modelId,
    securityModelId: left.securityModelId,
  }) === JSON.stringify({
    taskId: right.taskId,
    parentTaskId: right.parentTaskId,
    runId: right.runId,
    role: right.role,
    objective: right.objective,
    dependencies: right.dependencies,
    capabilityCeiling: right.capabilityCeiling,
    contextBudget: right.contextBudget,
    workspaceMode: right.workspaceMode,
    providerInstanceId: right.providerInstanceId,
    maxAttempts: right.maxAttempts,
    workflowKind: right.workflowKind,
    roleName: right.roleName,
    capabilities: right.capabilities,
    projectPath: right.projectPath,
    threadId: right.threadId,
    turnId: right.turnId,
    modelId: right.modelId,
    securityModelId: right.securityModelId,
  });
}
