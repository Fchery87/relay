import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runQueuedCheckpointComparison } from "./checkpoint-comparison-worker";
import { createCheckpoint } from "./checkpoints";
import { runCommand } from "./tools";

test("computes and completes a queued checkpoint comparison", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-checkpoint-compare-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test && git commit --allow-empty -m base", platform: "linux", root });
  await writeFile(join(root, "file.txt"), "one\n");
  const first = await createCheckpoint({ root, threadId: "thread", turnId: "one" });
  await writeFile(join(root, "file.txt"), "two\n");
  const second = await createCheckpoint({ root, threadId: "thread", turnId: "two" });
  const completions: Array<{ claimToken: string; comparisonId: string; content: string; status: string }> = [];

  await runQueuedCheckpointComparison({
    gateway: {
      claim: async () => ({ claimToken: "claim-1", comparisonId: "comparison", fromCommit: first.commit, projectPath: root, threadId: "thread", toCommit: second.commit }),
      complete: async (input) => { completions.push(input); },
    },
    resolveProjectRoot: async () => root,
  });

  expect(completions).toHaveLength(1);
  expect(completions[0]?.content).toContain("-one");
  expect(completions[0]?.content).toContain("+two");
});
