import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { commitChanges, computeDiff, stageAll } from "./git-review";
import { runCommand } from "./tools";

test("computes the cumulative worktree diff from its start commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-diff-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test", platform: "linux", root });
  await writeFile(join(root, "file.txt"), "before\n");
  await runCommand({ command: "git add . && git commit -m base", platform: "linux", root });
  const startCommit = (await runCommand({ command: "git rev-parse HEAD", platform: "linux", root })).stdout.trim();
  await writeFile(join(root, "file.txt"), "after\n");
  expect(await computeDiff({ root, startCommit })).toContain("+after");
});

test("stages and commits the reviewed worktree changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-ship-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test", platform: "linux", root });
  await writeFile(join(root, "file.txt"), "before\n");
  await runCommand({ command: "git add . && git commit -m base", platform: "linux", root });
  await writeFile(join(root, "file.txt"), "after\n");

  await stageAll({ root });
  const commit = await commitChanges({ message: "ship $(not-a-command)", root });
  const result = await runCommand({ command: "git log -1 --format=%H%n%s", platform: "linux", root });

  expect(result.stdout.trim()).toBe(`${commit}\nship $(not-a-command)`);
});
