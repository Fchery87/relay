import { expect, test } from "bun:test";
import { assertTaskMessage } from "./task-messages";
test("task messages validate progress bounds", () => { expect(() => assertTaskMessage({ type: "progress", taskId: "t" as never, completed: 2, total: 1, detail: "bad", createdAt: 1 })).toThrow("progress"); expect(() => assertTaskMessage({ type: "progress", taskId: "t" as never, completed: 1, total: 2, detail: "ok", createdAt: 1 })).not.toThrow(); });
