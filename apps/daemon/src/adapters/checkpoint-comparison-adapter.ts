// ---------------------------------------------------------------------------
// Checkpoint comparison adapter — bridges legacy diffCheckpoints into the
// kernel's canonical event model.
// ---------------------------------------------------------------------------

import { diffCheckpoints } from "../checkpoints";

export type CheckpointComparisonAdapterDeps = {
  resolveProjectRoot(input: { repoPath: string; threadId: string }): Promise<string>;
};

export type CheckpointComparisonInput = {
  fromCommit: string;
  fromCheckpointId: string;
  toCommit: string;
  toCheckpointId: string;
  projectPath: string;
  threadId: string;
};

export async function executeCheckpointComparison(
  input: CheckpointComparisonInput,
  deps: CheckpointComparisonAdapterDeps,
  runId: string,
): Promise<Array<{ eventId: string; type: string; payload: Record<string, unknown> }>> {
  const ts = Date.now();
  const root = await deps.resolveProjectRoot({
    repoPath: input.projectPath,
    threadId: input.threadId,
  });

  const diff = await diffCheckpoints({
    fromCommit: input.fromCommit,
    toCommit: input.toCommit,
    root,
  });
  // Keep the canonical projection bounded like every other cloud-facing
  // artifact. The legacy comparison path may retain the complete diff.
  const content = diff.length > 750_000 ? `${diff.slice(0, 750_000)}\n[diff truncated]` : diff;

  return [
    {
      eventId: `cmp-done-${runId}-${ts}`,
      type: "checkpoint.compared",
      payload: {
        content,
        fromCheckpointId: input.fromCheckpointId as never,
        toCheckpointId: input.toCheckpointId as never,
      },
    },
  ];
}
