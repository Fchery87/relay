import type { ModelProvider } from "./model-provider";
import type { MachinePlatform } from "@relay/shared";
import { executeToolCall } from "./tool-executor";
import { computeDiff } from "./git-review";

export interface ConversationGateway {
  appendAssistantText(input: { content: string; messageId: string }): Promise<unknown>;
  beginAssistantMessage(input: { threadId: string }): Promise<string>;
  claimQueuedMessage(input: { deviceToken: string }): Promise<{ content: string; projectPath: string; threadId: string } | null>;
  completeAssistantMessage(input: { messageId: string; threadId: string }): Promise<unknown>;
  recordToolCompleted?(input: { summary: string; threadId: string; tool: "bash" | "edit" | "read" }): Promise<unknown>;
  snapshotDiff?(input: { content: string; threadId: string }): Promise<unknown>;
}

export async function runQueuedTurn({
  deviceToken,
  gateway,
  provider,
  platform = "linux",
  resolveProjectRoot,
}: {
  deviceToken: string;
  gateway: ConversationGateway;
  provider: ModelProvider;
  platform?: MachinePlatform;
  resolveProjectRoot?: (input: { repoPath: string; threadId: string }) => Promise<string>;
}): Promise<boolean> {
  const queued = await gateway.claimQueuedMessage({ deviceToken });
  if (!queued) return false;

  const root = resolveProjectRoot ? await resolveProjectRoot({ repoPath: queued.projectPath, threadId: queued.threadId }) : queued.projectPath;
  const messageId = await gateway.beginAssistantMessage({ threadId: queued.threadId });
  if (provider.toolCalls) {
    let mutated = false;
    for await (const call of provider.toolCalls({ prompt: queued.content })) {
      await executeToolCall({
        call,
        onCompleted: async (event) => { await gateway.recordToolCompleted?.({ ...event, threadId: queued.threadId }); },
        platform,
        root,
      });
      if (call.kind === "edit" || call.kind === "bash") mutated = true;
    }
    if (mutated) await gateway.snapshotDiff?.({ content: await computeDiff({ root, startCommit: "HEAD" }), threadId: queued.threadId });
  }
  let content = "";
  let lastFlushAt = Date.now();
  for await (const chunk of provider.streamReply({ prompt: queued.content })) {
    content += chunk;
    if (Date.now() - lastFlushAt >= 200) {
      await gateway.appendAssistantText({ content, messageId });
      lastFlushAt = Date.now();
    }
  }
  await gateway.appendAssistantText({ content, messageId });
  await gateway.completeAssistantMessage({ messageId, threadId: queued.threadId });
  return true;
}
