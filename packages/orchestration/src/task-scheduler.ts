import type { TaskId, TaskSpec } from "@relay/contracts";
import { TaskGraph } from "./task-graph";

export class TaskScheduler {
  private readonly active = new Set<TaskId>();
  constructor(readonly graph: TaskGraph, private readonly limits = { maxActive: 4 }) {}
  next(): readonly TaskSpec[] { return this.graph.frontier(Math.max(0, this.limits.maxActive - this.active.size)); }
  claim(taskId: TaskId): TaskSpec { if (this.active.size >= this.limits.maxActive) throw new Error("Task concurrency limit reached"); const task = this.graph.get(taskId); if (!task || !this.next().some(t => t.taskId === taskId)) throw new Error("Task is not ready"); this.active.add(taskId); return task; }
  release(taskId: TaskId): void { this.active.delete(taskId); }
  activeCount(): number { return this.active.size; }
}
