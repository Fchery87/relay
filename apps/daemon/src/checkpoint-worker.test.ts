import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runQueuedCheckpointRestore } from "./checkpoint-worker";
import { createCheckpoint } from "./checkpoints";
import { runCommand } from "./tools";

test("restores a queued checkpoint and completes its action", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-checkpoint-worker-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test", platform: "linux", root });
  await writeFile(join(root, "file.txt"), "base\n");
  await runCommand({ command: "git add . && git commit -m base", platform: "linux", root });
  await writeFile(join(root, "file.txt"), "turn one\n");
  const checkpoint = await createCheckpoint({ root, threadId: "thread-1", turnId: "turn-1" });
  await writeFile(join(root, "file.txt"), "turn two\n");
  const completions: Array<{ actionId: string; claimToken: string; status: string }> = [];
  const diffs: string[] = [];

  expect(await runQueuedCheckpointRestore({
    gateway: {
      claim: async () => ({ actionId: "action-1", checkpointId: "checkpoint-1", claimToken: "claim-1", commit: checkpoint.commit, projectPath: root, threadId: "thread-1" }),
      complete: async (input) => { completions.push(input); },
      snapshotDiff: async ({ content }) => { diffs.push(content); },
    },
    resolveProjectRoot: async () => root,
  })).toBe(true);

  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("turn one\n");
  expect(completions).toEqual([{ actionId: "action-1", claimToken: "claim-1", status: "complete" }]);
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toContain("+turn one");
  expect(diffs[0]).not.toContain("+turn two");
});
