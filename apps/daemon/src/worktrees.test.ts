import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { createThreadWorktree } from "./worktrees";
import { editFile } from "./tools";
import { runCommand } from "./tools";

test("creates an isolated detached worktree for a thread", async () => {
  const repo = await mkdtemp(join(tmpdir(), "relay-repo-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test", platform: "linux", root: repo });
  await writeFile(join(repo, "shared.txt"), "base");
  await runCommand({ command: "git add . && git commit -m base", platform: "linux", root: repo });
  const home = await mkdtemp(join(tmpdir(), "relay-home-"));
  const worktree = await createThreadWorktree({ daemonHome: home, repoPath: repo, threadId: "thread-1" });
  expect(worktree).toBe(join(home, "worktrees", "thread-1"));
  expect((await runCommand({ command: "git branch --show-current", platform: "linux", root: worktree })).stdout.trim()).toBe("");
});

test("two thread worktrees mutate the same file without touching each other", async () => {
  const repo = await mkdtemp(join(tmpdir(), "relay-concurrent-repo-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test", platform: "linux", root: repo });
  await writeFile(join(repo, "shared.txt"), "base");
  await runCommand({ command: "git add . && git commit -m base", platform: "linux", root: repo });
  const home = await mkdtemp(join(tmpdir(), "relay-concurrent-home-"));
  const [first, second] = await Promise.all([
    createThreadWorktree({ daemonHome: home, repoPath: repo, threadId: "thread-a" }),
    createThreadWorktree({ daemonHome: home, repoPath: repo, threadId: "thread-b" }),
  ]);
  await Promise.all([
    editFile({ content: "first", path: "shared.txt", root: first }),
    editFile({ content: "second", path: "shared.txt", root: second }),
  ]);
  expect(await readFile(join(first, "shared.txt"), "utf8")).toBe("first");
  expect(await readFile(join(second, "shared.txt"), "utf8")).toBe("second");
  expect(await readFile(join(repo, "shared.txt"), "utf8")).toBe("base");
});
