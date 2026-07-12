import type { ModelProvider, ModelProviderRouter } from "./model-provider";
import { DEFAULT_MODEL_ID, type MachinePlatform, type TokenUsage } from "@relay/shared";
import { executeGovernedToolCall, type GovernanceGateway } from "./governed-tool-executor";
import { computeDiff } from "./git-review";
import type { Policy } from "./policy";

export interface ConversationGateway {
  appendAssistantText(input: { content: string; messageId: string }): Promise<unknown>;
  beginAssistantMessage(input: { threadId: string }): Promise<string>;
  claimQueuedMessage(input: { deviceToken: string }): Promise<{ content: string; modelId?: string; projectPath: string; reviewComments?: ReviewComment[]; thinkingLevel?: "none" | "low" | "medium" | "high"; threadId: string } | null>;
  completeAssistantMessage(input: { messageId: string; resolvedCommentIds?: string[]; threadId: string }): Promise<unknown>;
  recordUsage(input: { callId: string; messageId: string; modelId: string; role: string; threadId: string; usage: TokenUsage }): Promise<unknown>;
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
  governance,
  policy,
  provider,
  platform = "linux",
  resolveProjectRoot,
}: {
  deviceToken: string;
  gateway: ConversationGateway;
  governance: GovernanceGateway;
  policy: Policy;
  provider: ModelProvider | ModelProviderRouter;
  platform?: MachinePlatform;
  resolveProjectRoot?: (input: { repoPath: string; threadId: string }) => Promise<string>;
}): Promise<boolean> {
  const queued = await gateway.claimQueuedMessage({ deviceToken });
  if (!queued) return false;
  const turnProvider = isModelProviderRouter(provider)
    ? provider.resolve({ modelId: queued.modelId ?? DEFAULT_MODEL_ID, thinkingLevel: queued.thinkingLevel ?? "none" })
    : provider;
  const reviewComments = queued.reviewComments ?? [];
  const prompt = buildTurnPrompt({ content: queued.content, reviewComments });

  const root = resolveProjectRoot ? await resolveProjectRoot({ repoPath: queued.projectPath, threadId: queued.threadId }) : queued.projectPath;
  const messageId = await gateway.beginAssistantMessage({ threadId: queued.threadId });
  const toolResults: string[] = [];
  if (turnProvider.toolCalls) {
    let mutated = false;
    for await (const call of turnProvider.toolCalls({ prompt })) {
      const toolResult = await executeGovernedToolCall({
        call,
        governance,
        onCompleted: async (event) => { await gateway.recordToolCompleted?.({ ...event, threadId: queued.threadId }); },
        platform,
        policy,
        root,
        threadId: queued.threadId,
      });
      toolResults.push(toolResult.output);
      if (call.kind === "edit" || call.kind === "bash") mutated = true;
    }
    if (mutated) await gateway.snapshotDiff?.({ content: await computeDiff({ root, startCommit: "HEAD" }), threadId: queued.threadId });
  }
  let content = "";
  let usage: TokenUsage | null = null;
  let lastFlushAt = Date.now();
  const responsePrompt = toolResults.length === 0 ? prompt : `${prompt}\n\n<tool_results>\n${toolResults.map(escapeXml).join("\n")}\n</tool_results>`;
  for await (const event of turnProvider.streamReply({ prompt: responsePrompt })) {
    if (event.kind === "usage") {
      usage = event.usage;
      continue;
    }
    content += event.text;
    if (Date.now() - lastFlushAt >= 200) {
      await gateway.appendAssistantText({ content, messageId });
      lastFlushAt = Date.now();
    }
  }
  await gateway.appendAssistantText({ content, messageId });
  if (!usage) throw new Error("Model provider did not report usage");
  const modelId = turnProvider.modelId ?? queued.modelId ?? DEFAULT_MODEL_ID;
  await gateway.recordUsage({ callId: crypto.randomUUID(), messageId, modelId, role: "primary", threadId: queued.threadId, usage });
  await gateway.completeAssistantMessage({ messageId, resolvedCommentIds: reviewComments.map((comment) => comment.commentId), threadId: queued.threadId });
  return true;
}

function isModelProviderRouter(provider: ModelProvider | ModelProviderRouter): provider is ModelProviderRouter {
  return "kind" in provider && provider.kind === "model-router";
}
