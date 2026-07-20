import { expect, test } from "bun:test";
import { DurableTaskStore, openMemoryStore } from "./index";
const task = { taskId: "task-1" as never, runId: "run-1" as never, role: "builder" as const, objective: "build", dependencies: [], capabilityCeiling: "workspace-write", contextBudget: 1000, workspaceMode: "isolated-worktree" as const, state: "ready" as const, attempt: 0, maxAttempts: 3 };
test("durable tasks survive store reads and fence claims by generation", () => { const db = openMemoryStore(); const store = new DurableTaskStore(db); store.put(task); expect(store.get(task.taskId)?.objective).toBe("build"); expect(store.claim(task.taskId, "owner", 1000, 10)).toBe(1); expect(() => store.claim(task.taskId, "other", 1000, 11)).toThrow("not claimable"); db.close(); });
