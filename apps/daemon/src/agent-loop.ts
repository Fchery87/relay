import type { McpModelTool, ModelProvider, ModelProviderRouter } from "./model-provider";
import { resolveTurnProvider } from "./model-provider";
import { resolveProviderConfig } from "./model-router";
import { DEFAULT_MODEL_ID, narrowCapabilities, type Capability, type MachinePlatform, type SubagentResult, type TokenUsage } from "@relay/shared";
import { executeGovernedToolCall, summarizeToolCall, type GovernanceGateway, type GovernedToolResult } from "./governed-tool-executor";
import { computeDiff } from "./git-review";
import { createCheckpoint } from "./checkpoints";
import type { Policy } from "./policy";
import { classifyToolCall, effectivePolicy } from "./policy";
import { runAgenticTurn, type ChatMessage, type TurnCallbacks, type TurnModelProvider } from "./turn-loop";

export interface ConversationGateway {
  acknowledgeStop(input: { deviceToken: string; messageId: string; threadId: string }): Promise<unknown>;
  appendAssistantText(input: { content: string; messageId: string }): Promise<unknown>;
  beginAssistantMessage(input: { threadId: string }): Promise<string>;
  claimQueuedMessage(input: { deviceToken: string }): Promise<{ content: string; history?: Array<{ content: string; role: string }>; modelId?: string; permissionProfile?: "read-only" | "workspace-write" | "full-access"; planPhase?: "planning" | "building" | "complete"; projectPath: string; reviewComments?: ReviewComment[]; thinkingLevel?: "none" | "low" | "medium" | "high"; threadId: string } | null>;
  claimSteeringMessages(input: { deviceToken: string; threadId: string }): Promise<Array<{ content: string }>>;
  completeAssistantMessage(input: { messageId: string; resolvedCommentIds?: string[]; status?: "done" | "failed"; threadId: string }): Promise<unknown>;
  completePlanning?(input: { content: string; messageId: string; threadId: string }): Promise<unknown>;
  isStopRequested(input: { deviceToken: string; threadId: string }): Promise<boolean>;
  recordCheckpoint?(input: { commit: string; deviceToken: string; messageId: string; ref: string; threadId: string }): Promise<unknown>;
  recordMcpTaskStatus?(input: { serverId: string; status: string; taskId: string; threadId: string }): Promise<unknown>;
  requestMcpInput?(input: { prompts: unknown[]; serverId: string; threadId: string; toolName: string }): Promise<Record<string, unknown>>;
  enqueueSubagent?(input: { capabilities: Capability[]; depth: number; deviceToken: string; roleName: string; task: string; threadId: string }): Promise<string>;
  waitForSubagent?(input: { deviceToken: string; runId: string; threadId: string }): Promise<SubagentResult>;
  recordUsage(input: { callId: string; messageId: string; modelId: string; role: string; threadId: string; usage: TokenUsage }): Promise<unknown>;
  recordToolCompleted?(input: { summary: string; threadId: string; tool: "bash" | "edit" | "mcp" | "read" | "task" | "web_search" | "web_fetch" }): Promise<unknown>;
  snapshotDiff?(input: { content: string; threadId: string }): Promise<unknown>;
}

export interface McpToolGateway {
  callTool(input: { arguments: Record<string, unknown>; name: string; onInputRequired?: (input: { prompts: unknown[] }) => Promise<Record<string, unknown>>; onTaskStatus?: (task: { id: string; status: string }) => Promise<void> | void; serverId: string }): Promise<unknown>;
  listTools(): Promise<McpModelTool[]>;
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
  mcp,
  policy,
  provider,
  platform = "linux",
  resolveProjectRoot,
  yolo = false,
}: {
  deviceToken: string;
  gateway: ConversationGateway;
  governance: GovernanceGateway;
  mcp?: McpToolGateway;
  policy: Policy;
  provider: ModelProvider | ModelProviderRouter;
  platform?: MachinePlatform;
  resolveProjectRoot?: (input: { repoPath: string; threadId: string }) => Promise<string>;
  yolo?: boolean;
}): Promise<boolean> {
  const queued = await gateway.claimQueuedMessage({ deviceToken });
  if (!queued) return false;
  const turnProvider = isModelProviderRouter(provider)
    ? provider.resolve({ modelId: queued.modelId ?? DEFAULT_MODEL_ID, thinkingLevel: queued.thinkingLevel ?? "none" })
    : provider;
  const reviewComments = queued.reviewComments ?? [];
  const prompt = buildTurnPrompt({ content: queued.content, reviewComments });
  const mcpTools = mcp ? await mcp.listTools().catch(() => []) : [];

  const root = resolveProjectRoot ? await resolveProjectRoot({ repoPath: queued.projectPath, threadId: queued.threadId }) : queued.projectPath;
  const messageId = await gateway.beginAssistantMessage({ threadId: queued.threadId });
  const turnPolicy = effectivePolicy({ base: policy, profile: queued.permissionProfile ?? "workspace-write", yolo });
  try {
    // Use agentic loop if the resolved provider supports it
    if (isTurnModelProvider(turnProvider)) {
      return await runAgenticClaimedTurn({ deviceToken, gateway, governance, mcp, mcpTools, messageId, policy: turnPolicy, platform, prompt, queued, reviewComments, root, turnProvider });
    }
    return await runClaimedTurn({ deviceToken, gateway, governance, mcp, mcpTools, messageId, policy: turnPolicy, platform, prompt, queued, reviewComments, root, turnProvider });
  } catch (error) {
    // Mark the turn failed so claimQueuedMessage stops skipping this thread (it treats "running" as busy).
    // Without this, an uncaught error here leaves the thread stuck and every later message sits queued forever.
    await gateway.completeAssistantMessage({ messageId, status: "failed", threadId: queued.threadId }).catch(() => undefined);
    throw error;
  }
}

async function runClaimedTurn({
  deviceToken,
  gateway,
  governance,
  mcp,
  mcpTools,
  messageId,
  policy,
  platform,
  prompt,
  queued,
  reviewComments,
  root,
  turnProvider,
}: {
  deviceToken: string;
  gateway: ConversationGateway;
  governance: GovernanceGateway;
  mcp?: McpToolGateway;
  mcpTools: McpModelTool[];
  messageId: string;
  policy: Policy;
  platform: MachinePlatform;
  prompt: string;
  queued: { content: string; modelId?: string; permissionProfile?: "read-only" | "workspace-write" | "full-access"; planPhase?: "planning" | "building" | "complete"; projectPath: string; reviewComments?: ReviewComment[]; thinkingLevel?: "none" | "low" | "medium" | "high"; threadId: string };
  reviewComments: ReviewComment[];
  root: string;
  turnProvider: ModelProvider;
}): Promise<boolean> {
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
    for await (const call of turnProvider.toolCalls({ prompt, tools: mcpTools })) {
      if (await gateway.isStopRequested({ deviceToken, threadId: queued.threadId })) {
        await acknowledgeStoppedTurn({ deviceToken, gateway, messageId, threadId: queued.threadId });
        return true;
      }
      const toolResult = queued.planPhase === "planning" && call.kind !== "read" && call.kind !== "web_search" && call.kind !== "web_fetch" ? await refusePlanningMutation({ call, governance, threadId: queued.threadId }) : await executeGovernedToolCall({
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
        onMcp: mcp ? async (mcpCall) => {
          try { return await mcp.callTool({ arguments: mcpCall.arguments, name: mcpCall.name, onInputRequired: gateway.requestMcpInput ? (input) => gateway.requestMcpInput!({ ...input, serverId: mcpCall.serverId, threadId: queued.threadId, toolName: mcpCall.name }) : undefined, onTaskStatus: async (task) => { await gateway.recordMcpTaskStatus?.({ serverId: mcpCall.serverId, status: task.status, taskId: task.id, threadId: queued.threadId }); }, serverId: mcpCall.serverId }); }
          catch (error) { if (error instanceof Error && error.message === "MCP elicitation was cancelled") return { kind: "mcp_elicitation_cancelled" }; throw error; }
        } : undefined,
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
  let lastFlushAt: number | undefined;
  let lastFlushedContent = "";
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
        if (lastFlushAt === undefined || Date.now() - lastFlushAt >= 200) {
          await gateway.appendAssistantText({ content, messageId });
          lastFlushAt = Date.now();
          lastFlushedContent = content;
        }
      }
    } catch (error) {
      if (!stopped || !isAbortError(error)) throw error;
    } finally {
      monitoring = false;
      abortController.abort();
      await stopMonitor;
    }
    if (content !== lastFlushedContent) await gateway.appendAssistantText({ content, messageId });
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
  // Only return capabilities that can be delegated to subagents.
  // "search" is excluded because web search is executed by the model
  // provider natively, not by subagents.
  return [...new Set(policy.rules.filter((rule) => rule.decision !== "deny" && rule.capability !== "search").map((rule) => rule.capability as Capability))];
}

async function refusePlanningMutation({ call, governance, threadId }: { call: Parameters<typeof classifyToolCall>[0]; governance: GovernanceGateway; threadId: string }): Promise<GovernedToolResult> {
  const classification = classifyToolCall(call);
  await governance.recordDecision({ ...classification, decision: "deny", summary: summarizeToolCall(call), threadId });
  return { kind: "refused", output: JSON.stringify({ capability: classification.capability, kind: "tool_refusal", reason: "plan_requires_approval", risk: classification.risk }) };
}

/** Agentic turn loop — uses the new streaming provider interface. */
async function runAgenticClaimedTurn({
  deviceToken,
  gateway,
  governance,
  mcp,
  mcpTools,
  messageId,
  policy,
  platform,
  prompt,
  queued,
  reviewComments,
  root,
  turnProvider,
}: {
  deviceToken: string;
  gateway: ConversationGateway;
  governance: GovernanceGateway;
  mcp?: McpToolGateway;
  mcpTools: McpModelTool[];
  messageId: string;
  policy: Policy;
  platform: MachinePlatform;
  prompt: string;
  queued: { content: string; modelId?: string; permissionProfile?: "read-only" | "workspace-write" | "full-access"; planPhase?: "planning" | "building" | "complete"; projectPath: string; reviewComments?: ReviewComment[]; thinkingLevel?: "none" | "low" | "medium" | "high"; threadId: string };
  reviewComments: ReviewComment[];
  root: string;
  turnProvider: TurnModelProvider;
}): Promise<boolean> {
  let mutated = false;
  let checkpointed = false;
  const checkpointTurn = async () => {
    if (!mutated || checkpointed || !gateway.recordCheckpoint) return;
    const checkpoint = await createCheckpoint({ root, threadId: queued.threadId, turnId: messageId });
    await gateway.recordCheckpoint({ ...checkpoint, deviceToken, messageId, threadId: queued.threadId });
    checkpointed = true;
  };

  const abortController = new AbortController();
  let stopRequested = false;
  const stopMonitor = (async () => {
    while (!stopRequested) {
      if (await gateway.isStopRequested({ deviceToken, threadId: queued.threadId })) {
        stopRequested = true;
        abortController.abort();
        return;
      }
      await Bun.sleep(50);
    }
  })();

  const callbacks: TurnCallbacks = {
    executeToolCall: async (call) => {
      const toolResult = queued.planPhase === "planning" && call.kind !== "read" && call.kind !== "web_search" && call.kind !== "web_fetch"
        ? await refusePlanningMutation({ call, governance, threadId: queued.threadId })
        : await executeGovernedToolCall({
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
            onMcp: mcp ? async (mcpCall) => {
              try { return await mcp.callTool({ arguments: mcpCall.arguments, name: mcpCall.name, onInputRequired: gateway.requestMcpInput ? (input) => gateway.requestMcpInput!({ ...input, serverId: mcpCall.serverId, threadId: queued.threadId, toolName: mcpCall.name }) : undefined, onTaskStatus: async (task) => { await gateway.recordMcpTaskStatus?.({ serverId: mcpCall.serverId, status: task.status, taskId: task.id, threadId: queued.threadId }); }, serverId: mcpCall.serverId }); }
              catch (error) { if (error instanceof Error && error.message === "MCP elicitation was cancelled") return { kind: "mcp_elicitation_cancelled" }; throw error; }
            } : undefined,
            platform,
            policy,
            root,
            threadId: queued.threadId,
          });

      if (toolResult.kind === "executed" && (call.kind === "edit" || call.kind === "bash")) mutated = true;
      return { content: toolResult.output, isError: toolResult.kind === "refused", toolUseId: call.kind };
    },
    onText: async (text) => {
      // Forward text deltas to Convex (throttled)
      await gateway.appendAssistantText({ content: text, messageId });
    },
    claimSteering: async () => {
      const steering = await gateway.claimSteeringMessages({ deviceToken, threadId: queued.threadId });
      return steering.map((s) => s.content);
    },
  };

  try {
    const system = "You are Relay, an agent running on the user's machine. You have access to tools for reading files, editing files, running commands, searching the web, and delegating tasks to subagents. Always read a file before editing it. Be concise in your final replies.";
    const messages: ChatMessage[] = [{ content: prompt, role: "user" }];

    const result = await runAgenticTurn({
      messages,
      provider: turnProvider,
      signal: abortController.signal,
      system,
      tools: mcpTools,
      callbacks,
    });

    // Record usage
    const modelId = turnProvider.modelId ?? queued.modelId ?? DEFAULT_MODEL_ID;
    const role = queued.planPhase === "planning" ? "planner" : queued.planPhase === "building" ? "builder" : "primary";
    await gateway.recordUsage({ callId: crypto.randomUUID(), messageId, modelId, role, threadId: queued.threadId, usage: result.totalUsage });

    if (mutated) await gateway.snapshotDiff?.({ content: await computeDiff({ root, startCommit: "HEAD" }), threadId: queued.threadId });
    await checkpointTurn();

    if (stopRequested) {
      await acknowledgeStoppedTurn({ deviceToken, gateway, messageId, threadId: queued.threadId });
      return true;
    }

    if (queued.planPhase === "planning") {
      if (!gateway.completePlanning) throw new Error("Planning completion is not configured");
      const content = result.messages.filter((m) => m.role === "assistant").flatMap((m) => m.role === "assistant" ? m.blocks.filter((b) => b.kind === "text").map((b) => b.text) : []).join("\n");
      await gateway.completePlanning({ content, messageId, threadId: queued.threadId });
    } else {
      await gateway.completeAssistantMessage({ messageId, resolvedCommentIds: reviewComments.map((comment) => comment.commentId), threadId: queued.threadId });
    }

    return true;
  } catch (error) {
    if (stopRequested && isAbortError(error)) {
      await gateway.snapshotDiff?.({ content: await computeDiff({ root, startCommit: "HEAD" }), threadId: queued.threadId }).catch(() => undefined);
      await checkpointTurn();
      await acknowledgeStoppedTurn({ deviceToken, gateway, messageId, threadId: queued.threadId });
      return true;
    }
    await gateway.completeAssistantMessage({ messageId, status: "failed", threadId: queued.threadId }).catch(() => undefined);
    throw error;
  } finally {
    stopRequested = true;
    abortController.abort();
  }
}

function isTurnModelProvider(provider: ModelProvider | TurnModelProvider): provider is TurnModelProvider {
  return "streamTurn" in provider;
}
