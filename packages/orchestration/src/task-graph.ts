import type { TaskId, TaskSpec } from "@relay/contracts";
import { validateTaskGraph } from "@relay/contracts";

export class TaskGraph {
  private readonly tasks = new Map<TaskId, TaskSpec>();
  constructor(initial: readonly TaskSpec[] = []) { validateTaskGraph(initial); for (const task of initial) this.tasks.set(task.taskId, task); }
  add(task: TaskSpec): void { const next = [...this.tasks.values(), task]; validateTaskGraph(next); this.tasks.set(task.taskId, task); }
  get(taskId: TaskId): TaskSpec | undefined { return this.tasks.get(taskId); }
  all(): readonly TaskSpec[] { return [...this.tasks.values()].sort((a, b) => a.taskId.localeCompare(b.taskId)); }
  frontier(limit = 4): readonly TaskSpec[] { if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid frontier limit"); const done = new Set([...this.tasks.values()].filter(t => t.state === "completed").map(t => t.taskId)); return this.all().filter(t => (t.state === "pending" || t.state === "ready") && t.dependencies.every(dep => done.has(dep))).slice(0, limit); }
}
