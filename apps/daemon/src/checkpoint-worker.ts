import type { QueuedRestore } from "@relay/shared";

import { restoreCheckpoint } from "./checkpoints";
import { computeDiff } from "./git-review";

export interface CheckpointGateway {
  claim(): Promise<QueuedRestore | null>;
  complete(input: { actionId: string; claimToken: string; status: "complete" | "failed" }): Promise<unknown>;
  snapshotDiff?(input: { content: string; threadId: string }): Promise<unknown>;
}

export async function runQueuedCheckpointRestore({ gateway, resolveProjectRoot }: {
  gateway: CheckpointGateway;
  resolveProjectRoot(input: { repoPath: string; threadId: string }): Promise<string>;
}): Promise<boolean> {
  const queued = await gateway.claim();
  if (!queued) return false;
  try {
    const root = await resolveProjectRoot({ repoPath: queued.projectPath, threadId: queued.threadId });
    await restoreCheckpoint({ commit: queued.commit, root });
    await gateway.snapshotDiff?.({ content: await computeDiff({ root, startCommit: "HEAD" }), threadId: queued.threadId });
    await gateway.complete({ actionId: queued.actionId, claimToken: queued.claimToken, status: "complete" });
  } catch (error) {
    await gateway.complete({ actionId: queued.actionId, claimToken: queued.claimToken, status: "failed" });
    throw error;
  }
  return true;
}
