import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { commitChanges, computeDiff, computeGitPreview, stageAll, verifyGitPreview } from "./git-review";
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

test("computes a verifiable worktree preview and rejects a stale one", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-preview-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test", platform: "linux", root });
  await writeFile(join(root, "file.txt"), "before\n");
  await runCommand({ command: "git add . && git commit -m base", platform: "linux", root });

  const preview = await computeGitPreview({ action: "stage", root });
  expect(preview.head).toBeTruthy();
  expect(preview.stateHash).toBeTruthy();
  expect(preview.expiresAt).toBeGreaterThan(Date.now());

  // Verification should pass before any mutation
  await expect(verifyGitPreview(preview)).resolves.toBe(true);

  // Mutate the worktree
  await writeFile(join(root, "file.txt"), "changed\n");
  await expect(verifyGitPreview(preview)).rejects.toThrow("Git state changed");
});
