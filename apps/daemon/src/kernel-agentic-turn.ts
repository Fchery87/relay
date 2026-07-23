import { DEFAULT_MODEL_ID, type TokenUsage, type MachinePlatform } from "@relay/shared";
import type { CanonicalEventDraft } from "@relay/contracts";

import {
  runAgenticTurn,
  isPendingToolExecutionOutcome,
  type ChatMessage,
  type ToolExecutionOutcome,
  type TurnModelProvider,
} from "./turn-loop";
import type { GovernanceGateway } from "./governed-tool-executor";
import {
  executeGovernedToolCall,
  summarizeToolCall,
} from "./governed-tool-executor";
import type { Policy } from "./policy";
import { classifyToolCall, evaluatePolicy } from "./policy";
import type { ToolCall } from "./tool-executor";
import { sanitizeForProjection } from "@relay/local-store";

export type KernelAgenticApprovalContinuation = {
  readonly activityId: string;
  readonly call: ToolCall;
  readonly messages: ChatMessage[];
  readonly toolUseId: string;
  readonly turnId: string;
  readonly reviewCommentIds?: readonly string[];
};

export type KernelAgenticTurnResult = {
  readonly events: CanonicalEventDraft[];
  readonly pending?: {
    readonly approvalId: string;
    readonly continuationJson: string;
  };
  readonly reviewCommentIds?: readonly string[];
};

type KernelAgenticTurnInput = {
  readonly eventNamespace?: string;
  readonly messages: ChatMessage[];
  readonly platform: MachinePlatform;
  readonly policy: Policy;
  readonly provider: TurnModelProvider;
  readonly governance: GovernanceGateway;
  readonly root?: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly turnId: string;
  readonly reviewCommentIds?: readonly string[];
  readonly claimSteering?: () => Promise<string[]>;
  readonly suppressTerminal?: boolean;
};

export async function executeKernelAgenticTurn(
  input: KernelAgenticTurnInput,
): Promise<KernelAgenticTurnResult> {
  return runKernelAgenticLoop(input);
}

export async function resumeKernelAgenticTurn(input: {
  readonly continuationJson: string;
  readonly eventNamespace?: string;
  readonly governance: GovernanceGateway;
  readonly platform: MachinePlatform;
  readonly policy: Policy;
  readonly provider: TurnModelProvider;
  readonly resolution: "allow" | "deny";
  readonly root?: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly turnId: string;
  readonly claimSteering?: () => Promise<string[]>;
}): Promise<KernelAgenticTurnResult> {
  const continuation = parseContinuation(input.continuationJson);
  if (continuation.turnId !== input.turnId) {
    throw new Error(`Approval continuation turn ${continuation.turnId} does not match ${input.turnId}`);
  }

  const events: CanonicalEventDraft[] = [];
  const callbacks = createCallbacks({
    ...input,
    eventNamespace: input.eventNamespace ?? "resume",
    events,
    skipActivityStart: continuation.activityId,
    reviewCommentIds: continuation.reviewCommentIds,
  });
  const outcome = await callbacks.executeToolCall(continuation.call, {
    messages: continuation.messages,
    toolUseId: continuation.toolUseId,
  });
  if (isPendingToolExecutionOutcome(outcome)) {
    throw new Error("An approval continuation unexpectedly requested another approval");
  }

  const toolResult: ChatMessage = {
    role: "tool_results",
    results: [{
      content: outcome.content,
      isError: outcome.isError,
      toolUseId: continuation.toolUseId,
    }],
  };
  const result = await runKernelAgenticLoop({
    ...input,
    eventNamespace: input.eventNamespace ?? "resume",
    events,
    messages: [...continuation.messages, toolResult],
    callbacks,
    suppressTerminal: true,
  });
  return { ...result, reviewCommentIds: continuation.reviewCommentIds };
}

async function runKernelAgenticLoop(
  input: KernelAgenticTurnInput & {
    readonly callbacks?: ReturnType<typeof createCallbacks>;
    readonly events?: CanonicalEventDraft[];
  },
): Promise<KernelAgenticTurnResult> {
  const events = input.events ?? [];
  const callbacks = input.callbacks ?? createCallbacks({ ...input, events });
  const result = await runAgenticTurn({
    callbacks,
    ...(input.claimSteering ? { claimSteering: input.claimSteering } : {}),
    messages: input.messages,
    provider: input.provider,
    signal: input.signal,
    system: "",
    tools: [],
  });

  if (result.pending) {
    return { events, pending: result.pending, reviewCommentIds: input.reviewCommentIds };
  }
  if (!input.signal.aborted && !input.suppressTerminal) {
    events.push(event({
      eventId: `ev-agentic-${input.runId}-${input.turnId}-${input.eventNamespace ?? "turn"}-assistant-completed`,
      payload: {},
      runId: input.runId,
      turnId: input.turnId,
      type: "assistant.completed",
    }));
    events.push(event({
      eventId: `ev-agentic-${input.runId}-${input.turnId}-${input.eventNamespace ?? "turn"}-completed`,
      payload: {},
      runId: input.runId,
      turnId: input.turnId,
      type: "turn.completed",
    }));
  }
  return { events, reviewCommentIds: input.reviewCommentIds };
}

function createCallbacks(input: {
  readonly eventNamespace?: string;
  readonly events: CanonicalEventDraft[];
  readonly governance: GovernanceGateway;
  readonly platform: MachinePlatform;
  readonly policy: Policy;
  readonly root?: string;
  readonly runId: string;
  readonly resolution?: "allow" | "deny";
  readonly skipActivityStart?: string;
  readonly turnId: string;
  readonly reviewCommentIds?: readonly string[];
  readonly claimSteering?: () => Promise<string[]>;
}): {
  executeToolCall(
    call: ToolCall,
    context?: { readonly messages: ChatMessage[]; readonly toolUseId: string },
  ): Promise<ToolExecutionOutcome>;
  onText(text: string): Promise<void>;
  onUsage(usage: TokenUsage): void;
} {
  let deltaIndex = 0;
  return {
    async executeToolCall(call, context) {
      const toolUseId = context?.toolUseId ?? `tool-${deltaIndex}`;
      const activityId = `activity-tool-${input.turnId}-${safeId(toolUseId)}`;
      const classification = classifyToolCall(call);
      if (input.skipActivityStart !== activityId) {
        input.events.push(event({
          eventId: `ev-agentic-${input.runId}-${input.turnId}-${activityId}-started`,
          payload: { activityId, kind: "tool", toolName: call.kind },
          runId: input.runId,
          turnId: input.turnId,
          type: "activity.started",
        }));
      }

      if (!input.root) {
        input.events.push(event({
          eventId: `ev-agentic-${input.runId}-${input.turnId}-${activityId}-failed`,
          payload: { activityId, error: "Kernel tool execution requires an authorized workspace" },
          runId: input.runId,
          turnId: input.turnId,
          type: "activity.failed",
        }));
        return { content: "Authorized workspace unavailable; tool refused", isError: true, toolUseId };
      }

      if (input.resolution === undefined && evaluatePolicy({ ...classification, policy: input.policy }) === "ask") {
        if (!input.governance.createApproval || !context) {
          input.events.push(event({
            eventId: `ev-agentic-${input.runId}-${input.turnId}-${activityId}-failed`,
            payload: { activityId, error: "Kernel approval creation is not configured; tool refused" },
            runId: input.runId,
            turnId: input.turnId,
            type: "activity.failed",
          }));
          return { content: "Approval unavailable; tool refused", isError: true, toolUseId };
        }
        const continuation: KernelAgenticApprovalContinuation = {
          activityId,
          call,
          messages: context.messages,
          toolUseId,
          turnId: input.turnId,
          reviewCommentIds: input.reviewCommentIds,
        };
        const approvalId = await input.governance.createApproval({
          ...classification,
          continuationJson: JSON.stringify(continuation),
          summary: summarizeToolCall(call),
          threadId: input.runId,
          turnId: input.turnId,
        });
        input.events.push(event({
          eventId: `ev-agentic-${input.runId}-${input.turnId}-${activityId}-approval`,
          payload: {
            approvalId,
            capability: classification.capability,
            risk: classification.risk,
            details: summarizeToolCall(call),
          },
          runId: input.runId,
          turnId: input.turnId,
          type: "approval.requested",
        }));
        return {
          approvalId,
          continuationJson: JSON.stringify(continuation),
          status: "pending",
        };
      }

      const result = await executeGovernedToolCall({
        approvalResolution: input.resolution,
        call,
        governance: input.governance,
        onCompleted: async () => undefined,
        onOutput: async (output) => {
          input.events.push(event({
            eventId: `ev-agentic-${input.runId}-${input.turnId}-${activityId}-delta-${deltaIndex++}`,
            payload: { activityId, content: sanitizeForProjection(output).slice(0, 4_000) },
            runId: input.runId,
            turnId: input.turnId,
            type: "activity.delta",
          }));
        },
        platform: input.platform,
        policy: input.policy,
        root: input.root,
        threadId: input.runId,
      });
      input.events.push(event({
        eventId: `ev-agentic-${input.runId}-${input.turnId}-${activityId}-completed`,
        payload: {
          activityId,
          result: { output: sanitizeForProjection(result.output).slice(0, 4_000), succeeded: result.kind === "executed" && result.succeeded },
          summary: result.kind === "refused" ? "Tool refused" : "Tool completed",
        },
        runId: input.runId,
        turnId: input.turnId,
        type: "activity.completed",
      }));
      return {
        content: result.output,
        isError: result.kind === "refused" || (result.kind === "executed" && !result.succeeded),
        toolUseId,
      };
    },
    async onText(text) {
      input.events.push(event({
        eventId: `ev-agentic-${input.runId}-${input.turnId}-${input.eventNamespace ?? "turn"}-delta-${deltaIndex++}`,
        payload: { text: sanitizeForProjection(text) },
        runId: input.runId,
        turnId: input.turnId,
        type: "assistant.delta",
      }));
    },
    onUsage(usage) {
      input.events.push(event({
        eventId: `ev-agentic-${input.runId}-${input.turnId}-${input.eventNamespace ?? "turn"}-usage-${deltaIndex++}`,
        payload: {
          ...usage,
          thinkingTokens: usage.thinkingTokens ?? 0,
          modelId: DEFAULT_MODEL_ID,
        },
        runId: input.runId,
        turnId: input.turnId,
        type: "usage.recorded",
      }));
    },
    ...(input.claimSteering ? { claimSteering: input.claimSteering } : {}),
  };
}

function event(input: {
  readonly eventId: string;
  readonly payload: Record<string, unknown>;
  readonly runId: string;
  readonly turnId: string;
  readonly type: CanonicalEventDraft["type"];
}): CanonicalEventDraft {
  return {
    causationId: input.eventId as never,
    correlationId: `corr-${input.runId}-${input.turnId}` as never,
    eventId: input.eventId as never,
    payload: input.payload,
    runId: input.runId as never,
    turnId: input.turnId as never,
    type: input.type,
  } as CanonicalEventDraft;
}

function parseContinuation(json: string): KernelAgenticApprovalContinuation {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Kernel agentic approval continuation is not valid JSON");
  }
  if (!isRecord(value) || typeof value.activityId !== "string" || typeof value.toolUseId !== "string" || typeof value.turnId !== "string" || !isRecord(value.call) || typeof value.call.kind !== "string" || !Array.isArray(value.messages) || !value.messages.every(isChatMessage)) {
    throw new Error("Kernel agentic approval continuation is malformed");
  }
  return {
    activityId: value.activityId,
    call: value.call as unknown as ToolCall,
    messages: value.messages,
    toolUseId: value.toolUseId,
    turnId: value.turnId,
    reviewCommentIds: value.reviewCommentIds === undefined
      ? undefined
      : Array.isArray(value.reviewCommentIds) && value.reviewCommentIds.every((commentId) => typeof commentId === "string")
        ? value.reviewCommentIds
        : (() => { throw new Error("Kernel agentic approval continuation has malformed review comment IDs"); })(),
  };
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant" && value.role !== "tool_results")) return false;
  if (value.role === "user") return typeof value.content === "string";
  if (value.role === "assistant") return Array.isArray(value.blocks);
  return Array.isArray(value.results) && value.results.every((result) => isRecord(result) && typeof result.content === "string" && typeof result.toolUseId === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}
