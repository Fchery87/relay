import type { TaskId, TaskSpec } from "@relay/contracts";
import type { StoreDatabase } from "./database";
export class DurableTaskStore {
  constructor(private readonly db: StoreDatabase) {}
  put(task: TaskSpec): void { this.db.run("INSERT INTO durable_tasks(task_id,run_id,parent_task_id,state,payload_json,attempt,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json,attempt=excluded.attempt,updated_at=excluded.updated_at", [task.taskId as string, task.runId as string, (task.parentTaskId as string | undefined) ?? null, task.state, JSON.stringify(task), task.attempt, Date.now()]); }
  get(taskId: TaskId): TaskSpec | undefined { const row = this.db.query("SELECT payload_json FROM durable_tasks WHERE task_id=?").get(taskId as string) as { payload_json: string } | null; return row ? JSON.parse(row.payload_json) as TaskSpec : undefined; }
  claim(taskId: TaskId, owner: string, leaseMs: number, now = Date.now()): number { const row = this.db.query("SELECT lease_generation,state FROM durable_tasks WHERE task_id=?").get(taskId as string) as { lease_generation: number; state: string } | null; if (!row || !["pending","ready"].includes(row.state)) throw new Error("Task is not claimable"); const generation = row.lease_generation + 1; this.db.run("UPDATE durable_tasks SET state='running',lease_owner=?,lease_expires_at=?,lease_generation=?,updated_at=? WHERE task_id=?", [owner, now + leaseMs, generation, now, taskId as string]); return generation; }
}
