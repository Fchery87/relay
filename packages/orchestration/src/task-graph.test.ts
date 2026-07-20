import { expect, test } from "bun:test";
import { TaskGraph } from "./task-graph";
import { TaskScheduler } from "./task-scheduler";
const task = (id: string, dependencies: string[] = [], state: "pending" | "completed" = "pending") => ({ taskId: id as never, runId: "run" as never, role: "builder" as const, objective: id, dependencies: dependencies as never[], capabilityCeiling: "read-only", contextBudget: 100, workspaceMode: "shared-read" as const, state, attempt: 0, maxAttempts: 2 });
test("task graph validates dependencies and deterministic frontier", () => { const graph = new TaskGraph([task("b", ["a"]), task("a")]); expect(graph.frontier().map(t => String(t.taskId))).toEqual(["a"]); });
test("scheduler enforces active limit", () => { const scheduler = new TaskScheduler(new TaskGraph([task("a"), task("b")]), { maxActive: 1 }); scheduler.claim("a" as never); expect(() => scheduler.claim("b" as never)).toThrow("concurrency"); scheduler.release("a" as never); });
