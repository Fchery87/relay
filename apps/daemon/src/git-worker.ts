import { commitChanges, pushChanges, stageAll } from "./git-review";

export async function runQueuedGitAction({ gateway, resolveProjectRoot }: {
  gateway: { claim(): Promise<{ action: "stage" | "commit" | "push"; actionId: string; message?: string; projectPath: string; threadId: string } | null>; complete(input: { actionId: string; status: "complete" | "failed" }): Promise<unknown> };
  resolveProjectRoot(input: { repoPath: string; threadId: string }): Promise<string>;
}): Promise<boolean> {
  const queued = await gateway.claim();
  if (!queued) return false;
  const root = await resolveProjectRoot({ repoPath: queued.projectPath, threadId: queued.threadId });
  try {
    if (queued.action === "stage") await stageAll({ root });
    else if (queued.action === "commit") await commitChanges({ message: queued.message ?? "Relay changes", root });
    else await pushChanges({ root });
    await gateway.complete({ actionId: queued.actionId, status: "complete" });
  } catch (error) {
    await gateway.complete({ actionId: queued.actionId, status: "failed" });
    throw error;
  }
  return true;
}
