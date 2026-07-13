import type { ModelProvider, ModelProviderRouter } from "./model-provider";
import { DEFAULT_MODEL_ID, narrowCapabilities, type Capability, type MachinePlatform, type SubagentResult, type TokenUsage } from "@relay/shared";
import { executeGovernedToolCall, summarizeToolCall, type GovernanceGateway, type GovernedToolResult } from "./governed-tool-executor";
import { computeDiff } from "./git-review";
import { createCheckpoint } from "./checkpoints";
import type { Policy } from "./policy";
import { classifyToolCall } from "./policy";

export interface ConversationGateway {
  acknowledgeStop(input: { deviceToken: string; messageId: string; threadId: string }): Promise<unknown>;
  appendAssistantText(input: { content: string; messageId: string }): Promise<unknown>;
  beginAssistantMessage(input: { threadId: string }): Promise<string>;
  claimQueuedMessage(input: { deviceToken: string }): Promise<{ content: string; modelId?: string; planPhase?: "planning" | "building" | "complete"; projectPath: string; reviewComments?: ReviewComment[]; thinkingLevel?: "none" | "low" | "medium" | "high"; threadId: string } | null>;
  claimSteeringMessages(input: { deviceToken: string; threadId: string }): Promise<Array<{ content: string }>>;
  completeAssistantMessage(input: { messageId: string; resolvedCommentIds?: string[]; threadId: string }): Promise<unknown>;
  completePlanning?(input: { content: string; messageId: string; threadId: string }): Promise<unknown>;
  isStopRequested(input: { deviceToken: string; threadId: string }): Promise<boolean>;
  recordCheckpoint?(input: { commit: string; deviceToken: string; messageId: string; ref: string; threadId: string }): Promise<unknown>;
  enqueueSubagent?(input: { capabilities: Capability[]; depth: number; deviceToken: string; roleName: string; task: string; threadId: string }): Promise<string>;
  waitForSubagent?(input: { deviceToken: string; runId: string; threadId: string }): Promise<SubagentResult>;
  recordUsage(input: { callId: string; messageId: string; modelId: string; role: string; threadId: string; usage: TokenUsage }): Promise<unknown>;
  recordToolCompleted?(input: { summary: string; threadId: string; tool: "bash" | "edit" | "read" | "task" }): Promise<unknown>;
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
  const steeringMessages: string[] = [];
  const toolResults: string[] = [];
  let checkpointed = false;
  let mutated = false;
  const checkpointTurn = async () => {
    if (!mutated || checkpointed || !gateway.recordCheckpoint) return;
    const checkpoint = await createCheckpoint({ root, threadId: queued.threadId, turnId: messageId });
    await gateway.recordCheckpoint({ ...checkpoint, deviceToken, messageId, threadId: queued.threadId });
    checkpointed = true;
  };
  if (turnProvider.toolCalls) {
    for await (const call of turnProvider.toolCalls({ prompt })) {
      if (await gateway.isStopRequested({ deviceToken, threadId: queued.threadId })) {
        await acknowledgeStoppedTurn({ deviceToken, gateway, messageId, threadId: queued.threadId });
        return true;
      }
      const toolResult = queued.planPhase === "planning" && call.kind !== "read" ? await refusePlanningMutation({ call, governance, threadId: queued.threadId }) : await executeGovernedToolCall({
        call,
        governance,
        onTask: gateway.enqueueSubagent ? async (taskCall) => {
          let capabilities: Capability[];
          try { capabilities = narrowCapabilities({ child: taskCall.capabilities, depth: 1, parent: policyCapabilities(policy) }); }
          catch { return JSON.stringify({ capability: "task", kind: "tool_refusal", reason: "capability_escalation", risk: "critical" }); }
          const runId = await gateway.enqueueSubagent!({ capabilities, depth: 1, deviceToken, roleName: taskCall.role, task: taskCall.task, threadId: queued.threadId });
          return JSON.stringify(gateway.waitForSubagent ? await gateway.waitForSubagent({ deviceToken, runId, threadId: queued.threadId }) : { kind: "subagent_queued", runId });
        } : undefined,
        onCompleted: async (event) => { await gateway.recordToolCompleted?.({ ...event, threadId: queued.threadId }); },
        platform,
        policy,
        root,
        threadId: queued.threadId,
      });
      toolResults.push(toolResult.output);
      if (toolResult.kind === "executed" && (call.kind === "edit" || call.kind === "bash")) mutated = true;
      if (await gateway.isStopRequested({ deviceToken, threadId: queued.threadId })) {
        if (mutated) await gateway.snapshotDiff?.({ content: await computeDiff({ root, startCommit: "HEAD" }), threadId: queued.threadId });
        await checkpointTurn();
        await acknowledgeStoppedTurn({ deviceToken, gateway, messageId, threadId: queued.threadId });
        return true;
      }
      const steering = await gateway.claimSteeringMessages({ deviceToken, threadId: queued.threadId });
      steeringMessages.push(...steering.map(({ content: steeringContent }) => steeringContent));
      if (steering.length > 0) break;
    }
    if (mutated) await gateway.snapshotDiff?.({ content: await computeDiff({ root, startCommit: "HEAD" }), threadId: queued.threadId });
  }
  let content = "";
  let usage: TokenUsage | null = null;
  let lastFlushAt = Date.now();
  const toolContext = toolResults.length === 0 ? "" : `\n\n<tool_results>\n${toolResults.map(escapeXml).join("\n")}\n</tool_results>`;
  const steeringContext = steeringMessages.length === 0 ? "" : `\n\n<steering_messages>\n${steeringMessages.map((message) => `<message>${escapeXml(message)}</message>`).join("\n")}\n</steering_messages>`;
  const responsePrompt = `${prompt}${toolContext}${steeringContext}`;
  if (await gateway.isStopRequested({ deviceToken, threadId: queued.threadId })) {
    await checkpointTurn();
    await acknowledgeStoppedTurn({ deviceToken, gateway, messageId, threadId: queued.threadId });
    return true;
  }
  try {
    const abortController = new AbortController();
    let monitoring = true;
    let stopped = false;
    const stopMonitor = monitorStop({
      deviceToken,
      gateway,
      onStop: () => { stopped = true; abortController.abort(); },
      shouldContinue: () => monitoring,
      threadId: queued.threadId,
    });
    try {
      for await (const event of turnProvider.streamReply({ prompt: responsePrompt, signal: abortController.signal })) {
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
    } catch (error) {
      if (!stopped || !isAbortError(error)) throw error;
    } finally {
      monitoring = false;
      abortController.abort();
      await stopMonitor;
    }
    await gateway.appendAssistantText({ content, messageId });
    if (stopped) {
      await acknowledgeStoppedTurn({ deviceToken, gateway, messageId, threadId: queued.threadId });
      return true;
    }
    if (!usage) throw new Error("Model provider did not report usage");
    const modelId = turnProvider.modelId ?? queued.modelId ?? DEFAULT_MODEL_ID;
    const role = queued.planPhase === "planning" ? "planner" : queued.planPhase === "building" ? "builder" : "primary";
    await gateway.recordUsage({ callId: crypto.randomUUID(), messageId, modelId, role, threadId: queued.threadId, usage });
  } finally {
    await checkpointTurn();
  }
  if (queued.planPhase === "planning") {
    if (!gateway.completePlanning) throw new Error("Planning completion is not configured");
    await gateway.completePlanning({ content, messageId, threadId: queued.threadId });
  } else {
    await gateway.completeAssistantMessage({ messageId, resolvedCommentIds: reviewComments.map((comment) => comment.commentId), threadId: queued.threadId });
  }
  return true;
}

async function acknowledgeStoppedTurn({ deviceToken, gateway, messageId, threadId }: { deviceToken: string; gateway: ConversationGateway; messageId: string; threadId: string }): Promise<void> {
  await gateway.acknowledgeStop({ deviceToken, messageId, threadId });
}

async function monitorStop({ deviceToken, gateway, onStop, shouldContinue, threadId }: {
  deviceToken: string;
  gateway: ConversationGateway;
  onStop(): void;
  shouldContinue(): boolean;
  threadId: string;
}): Promise<void> {
  while (shouldContinue()) {
    if (await gateway.isStopRequested({ deviceToken, threadId })) {
      onStop();
      return;
    }
    await Bun.sleep(50);
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function isModelProviderRouter(provider: ModelProvider | ModelProviderRouter): provider is ModelProviderRouter {
  return "kind" in provider && provider.kind === "model-router";
}

function policyCapabilities(policy: Policy): Capability[] {
  return [...new Set(policy.rules.filter((rule) => rule.decision !== "deny").map((rule) => rule.capability))];
}

async function refusePlanningMutation({ call, governance, threadId }: { call: Parameters<typeof classifyToolCall>[0]; governance: GovernanceGateway; threadId: string }): Promise<GovernedToolResult> {
  const classification = classifyToolCall(call);
  await governance.recordDecision({ ...classification, decision: "deny", summary: summarizeToolCall(call), threadId });
  return { kind: "refused", output: JSON.stringify({ capability: classification.capability, kind: "tool_refusal", reason: "plan_requires_approval", risk: classification.risk }) };
}
