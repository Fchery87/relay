import { expect, test } from "bun:test";

import { toolEventSchema } from "./tools";

test("accepts a streamed command output event", () => {
  expect(toolEventSchema.parse({ kind: "command.output", output: "tests passed\n", threadId: "thread-1" })).toMatchObject({ kind: "command.output" });
});

test("accepts a completed file edit event", () => {
  expect(toolEventSchema.parse({ kind: "tool.completed", summary: "Edited README.md", threadId: "thread-1", tool: "edit" })).toMatchObject({ tool: "edit" });
});
