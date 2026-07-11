import type { ModelProvider } from "./model-provider";
import type { MachinePlatform } from "@relay/shared";
import { executeToolCall } from "./tool-executor";
import { computeDiff } from "./git-review";

export interface ConversationGateway {
  appendAssistantText(input: { content: string; messageId: string }): Promise<unknown>;
  beginAssistantMessage(input: { threadId: string }): Promise<string>;
  claimQueuedMessage(input: { deviceToken: string }): Promise<{ content: string; projectPath: string; reviewComments?: ReviewComment[]; threadId: string } | null>;
  completeAssistantMessage(input: { messageId: string; resolvedCommentIds?: string[]; threadId: string }): Promise<unknown>;
  recordToolCompleted?(input: { summary: string; threadId: string; tool: "bash" | "edit" | "read" }): Promise<unknown>;
  snapshotDiff?(input: { content: string; threadId: string }): Promise<unknown>;
}

export type ReviewComment = { commentId: string; content: string; endLine: number; filePath: string; startLine: number };

export function buildTurnPrompt({ content, reviewComments }: { content: string; reviewComments: ReviewComment[] }): string {
  if (reviewComments.length === 0) return content;
  const comments = reviewComments.map((comment) => `<comment id="${escapeXml(comment.commentId)}" file="${escapeXml(comment.filePath)}" lines="${comment.startLine}-${comment.endLine}">
${escapeXml(comment.content)}
</comment>`).join("\n");
  return `${content}\n\n<review_feedback>\n${comments}\n</review_feedback>`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
  const reviewComments = queued.reviewComments ?? [];
  const prompt = buildTurnPrompt({ content: queued.content, reviewComments });

  const root = resolveProjectRoot ? await resolveProjectRoot({ repoPath: queued.projectPath, threadId: queued.threadId }) : queued.projectPath;
  const messageId = await gateway.beginAssistantMessage({ threadId: queued.threadId });
  if (provider.toolCalls) {
    let mutated = false;
    for await (const call of provider.toolCalls({ prompt })) {
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
  for await (const chunk of provider.streamReply({ prompt })) {
    content += chunk;
    if (Date.now() - lastFlushAt >= 200) {
      await gateway.appendAssistantText({ content, messageId });
      lastFlushAt = Date.now();
    }
  }
  await gateway.appendAssistantText({ content, messageId });
  await gateway.completeAssistantMessage({ messageId, resolvedCommentIds: reviewComments.map((comment) => comment.commentId), threadId: queued.threadId });
  return true;
}
