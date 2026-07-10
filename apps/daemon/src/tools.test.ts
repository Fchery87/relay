import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { editFile, resolveInsideRoot } from "./tools";

test("rejects paths outside the project root", () => {
  expect(() => resolveInsideRoot({ path: "../secret", root: "/repo" })).toThrow("outside project root");
});

test("edits a file inside the project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-tools-"));
  await editFile({ content: "hello", path: "note.txt", root });
  expect(await readFile(join(root, "note.txt"), "utf8")).toBe("hello");
});
