import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCheckpoint, deleteCheckpointNamespace, diffCheckpoints, restoreCheckpoint } from "./checkpoints";
import { runCommand } from "./tools";

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "relay-checkpoints-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test", platform: "linux", root });
  await writeFile(join(root, "file.txt"), "base\n");
  await runCommand({ command: "git add . && git commit -m base", platform: "linux", root });
  return root;
}

test("creates a hidden checkpoint for tracked and untracked changes without moving HEAD", async () => {
  const root = await createRepository();
  const head = (await runCommand({ command: "git rev-parse HEAD", platform: "linux", root })).stdout.trim();
  await writeFile(join(root, "file.txt"), "turn one\n");
  await writeFile(join(root, "new.txt"), "created\n");

  const checkpoint = await createCheckpoint({ root, threadId: "thread-1", turnId: "turn-1" });

  expect((await runCommand({ command: "git rev-parse HEAD", platform: "linux", root })).stdout.trim()).toBe(head);
  expect((await runCommand({ command: "git show refs/relay/checkpoints/thread-1/turn-1:file.txt", platform: "linux", root })).stdout).toBe("turn one\n");
  expect((await runCommand({ command: "git show refs/relay/checkpoints/thread-1/turn-1:new.txt", platform: "linux", root })).stdout).toBe("created\n");
  expect(checkpoint.ref).toBe("refs/relay/checkpoints/thread-1/turn-1");
  expect(checkpoint.commit).not.toBe(head);
});

test("restores a checkpoint without deleting later checkpoint refs", async () => {
  const root = await createRepository();
  await writeFile(join(root, "file.txt"), "turn one\n");
  const first = await createCheckpoint({ root, threadId: "thread-1", turnId: "turn-1" });
  await writeFile(join(root, "file.txt"), "turn two\n");
  await writeFile(join(root, "later.txt"), "later\n");
  await createCheckpoint({ root, threadId: "thread-1", turnId: "turn-2" });

  await restoreCheckpoint({ commit: first.commit, root });

  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("turn one\n");
  expect(await Bun.file(join(root, "later.txt")).exists()).toBe(false);
  expect((await runCommand({ command: "git rev-parse --verify refs/relay/checkpoints/thread-1/turn-2", platform: "linux", root })).exitCode).toBe(0);
});

test("deletes only one thread checkpoint namespace", async () => {
  const root = await createRepository();
  await createCheckpoint({ root, threadId: "thread-1", turnId: "turn-1" });
  await createCheckpoint({ root, threadId: "thread-2", turnId: "turn-1" });

  await deleteCheckpointNamespace({ root, threadId: "thread-1" });

  expect((await runCommand({ command: "git show-ref --verify --quiet refs/relay/checkpoints/thread-1/turn-1", platform: "linux", root })).exitCode).not.toBe(0);
  expect((await runCommand({ command: "git show-ref --verify --quiet refs/relay/checkpoints/thread-2/turn-1", platform: "linux", root })).exitCode).toBe(0);
});

test("diffs any two checkpoint commits", async () => {
  const root = await createRepository();
  await writeFile(join(root, "file.txt"), "turn one\n");
  const first = await createCheckpoint({ root, threadId: "thread-1", turnId: "turn-1" });
  await writeFile(join(root, "file.txt"), "turn two\n");
  const second = await createCheckpoint({ root, threadId: "thread-1", turnId: "turn-2" });

  const diff = await diffCheckpoints({ fromCommit: first.commit, root, toCommit: second.commit });

  expect(diff).toContain("-turn one");
  expect(diff).toContain("+turn two");
});
