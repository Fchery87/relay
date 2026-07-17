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
  toCommit: string;
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

  return [
    {
      eventId: `cmp-done-${runId}-${ts}`,
      type: "activity.completed",
      payload: {
        activityId: `cmp-${runId}`,
        kind: "checkpoint-comparison",
        summary: diff.slice(0, 2000),
      },
    },
  ];
}
