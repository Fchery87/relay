import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { executeToolCall } from "./tool-executor";

test("executes a scripted edit and records its event", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-edit-"));
  const events: Array<{ summary: string; tool: string }> = [];
  await executeToolCall({
    call: { content: "created by agent", kind: "edit", path: "result.txt" },
    onCompleted: async (event) => { events.push(event); },
    platform: "linux",
    root,
  });
  expect(await readFile(join(root, "result.txt"), "utf8")).toBe("created by agent");
  expect(events).toEqual([{ summary: "Edited result.txt", tool: "edit" }]);
});
