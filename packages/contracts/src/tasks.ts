import type { ProviderInstanceId, RunId } from "./ids";

export type TaskId = string & { readonly __taskId: unique symbol };
export type TaskState = "pending" | "ready" | "running" | "blocked" | "completed" | "failed" | "cancelled";
export type TaskRole = "explorer" | "builder" | "reviewer" | "integrator";
export type TaskSpec = Readonly<{
  taskId: TaskId; parentTaskId?: TaskId; runId: RunId; role: TaskRole; objective: string;
  dependencies: readonly TaskId[]; capabilityCeiling: string; contextBudget: number;
  workspaceMode: "shared-read" | "isolated-worktree"; providerInstanceId?: ProviderInstanceId;
  state: TaskState; attempt: number; maxAttempts: number; workflowKind?: string; roleName?: string;
  capabilities?: readonly string[]; projectPath?: string; threadId?: string; turnId?: string; modelId?: string; securityModelId?: string;
  result?: unknown; error?: string;
}>;

export function validateTaskGraph(tasks: readonly TaskSpec[]): void {
  const ids = new Set<string>(); for (const task of tasks) { if (ids.has(task.taskId)) throw new Error(`Duplicate task: ${task.taskId}`); ids.add(task.taskId); if (task.dependencies.includes(task.taskId)) throw new Error("Task cannot depend on itself"); }
  for (const task of tasks) for (const dep of task.dependencies) if (!ids.has(dep)) throw new Error(`Missing dependency: ${dep}`);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) throw new Error("Task graph contains a cycle"); if (visited.has(id)) return; visiting.add(id); const task = tasks.find(t => t.taskId === id)!; task.dependencies.forEach(visit); visiting.delete(id); visited.add(id); };
  tasks.forEach(t => visit(t.taskId));
}
