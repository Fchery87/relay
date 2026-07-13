import type { QueuedComparison } from "@relay/shared";

import { diffCheckpoints } from "./checkpoints";

export async function runQueuedCheckpointComparison({ gateway, resolveProjectRoot }: {
  gateway: {
    claim(): Promise<QueuedComparison | null>;
    complete(input: { claimToken: string; comparisonId: string; content: string; status: "complete" | "failed" }): Promise<unknown>;
  };
  resolveProjectRoot(input: { repoPath: string; threadId: string }): Promise<string>;
}): Promise<boolean> {
  const queued = await gateway.claim();
  if (!queued) return false;
  try {
    const root = await resolveProjectRoot({ repoPath: queued.projectPath, threadId: queued.threadId });
    const content = await diffCheckpoints({ fromCommit: queued.fromCommit, root, toCommit: queued.toCommit });
    await gateway.complete({ claimToken: queued.claimToken, comparisonId: queued.comparisonId, content, status: "complete" });
  } catch (error) {
    await gateway.complete({ claimToken: queued.claimToken, comparisonId: queued.comparisonId, content: "", status: "failed" });
    throw error;
  }
  return true;
}
