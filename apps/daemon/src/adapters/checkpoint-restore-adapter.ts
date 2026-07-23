// ---------------------------------------------------------------------------
// Checkpoint restore adapter — bridges legacy restoreCheckpoint/git-review
// into the kernel's canonical event model.
// ---------------------------------------------------------------------------

import { restoreCheckpoint } from "../checkpoints";
import { computeDiff } from "../git-review";

export type CheckpointRestoreAdapterDeps = {
  resolveProjectRoot(input: { repoPath: string; threadId: string }): Promise<string>;
  snapshotDiff?(input: { content: string; threadId: string }): Promise<void>;
};

export type CheckpointRestoreInput = {
  commit: string;
  projectPath: string;
  threadId: string;
};

export async function executeCheckpointRestore(
  input: CheckpointRestoreInput,
  deps: CheckpointRestoreAdapterDeps,
  runId: string,
): Promise<Array<{ eventId: string; type: string; payload: Record<string, unknown> }>> {
  const ts = Date.now();
  const root = await deps.resolveProjectRoot({
    repoPath: input.projectPath,
    threadId: input.threadId,
  });

  await restoreCheckpoint({ commit: input.commit, root });
  const diff = await computeDiff({ root, startCommit: "HEAD" });

  if (deps.snapshotDiff) {
    await deps.snapshotDiff({ content: diff, threadId: input.threadId });
  }

  return [
    {
      eventId: `ckpt-restore-${runId}-${ts}`,
      type: "checkpoint.restored",
      payload: {
        checkpointId: `ckpt-${input.commit.slice(0, 7)}`,
        commit: input.commit,
      },
    },
    {
      eventId: `ckpt-diff-${runId}-${ts}`,
      type: "workspace.diff.updated",
      payload: {
        baseCommit: "HEAD",
        content: diff.length > 750_000 ? `${diff.slice(0, 750_000)}\n[diff truncated]` : diff,
      },
    },
  ];
}
