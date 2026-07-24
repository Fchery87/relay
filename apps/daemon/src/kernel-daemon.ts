// ---------------------------------------------------------------------------
// Kernel daemon — the kernel-mode daemon runner.
// Wires LocalHarnessRuntime + Convex command gateway/projection sink + provider
// into a single polling loop, replacing the legacy per-work-type pollers.
//
// Activated when RELAY_RUNTIME_MODE=kernel or shadow.
// When RELAY_CODEX_ENABLED=1, turn.send uses a real Codex app-server session
// adapter instead of the catalog LLM provider.
// ---------------------------------------------------------------------------

import { hostname } from "node:os";
import { join } from "node:path";
import { mkdir, statfs, writeFile } from "node:fs/promises";

import { isDeviceTokenRejected } from "./device-auth";
import { createCodexSessionAdapter, type CodexSessionAdapter, type CodexTransportConfig, type NormalizedEvent } from "@relay/codex-app-server";
import {
  LocalHarnessRuntime,
  type AppendEventInput,
  type AppendEventResult,
} from "@relay/harness-runtime";
import {
  juryFindingToReviewComment,
  mergeJuryFindings,
  parseJuryFindings,
  REVIEW_JURY_FINDINGS_FORMAT,
  MutableReactorRegistry,
} from "@relay/orchestration";
import type { EffectIntent, EffectReactor } from "@relay/contracts";
import {
  canonicalEventPayloadError,
  canonicalEventRequiresTurn,
} from "@relay/contracts";
import type { CanonicalEventDraft, PlanPhase, ReviewCommentInput } from "@relay/contracts";
import { DEFAULT_MODEL_ID, type Capability } from "@relay/shared";
import {
  createConvexCommandSource,
} from "./sync/convex-command-source";
import type { CommandGateway } from "./sync/convex-command-source";
import {
  createConvexProjectionSink,
} from "./sync/convex-projection-sink";
import type { ProjectionSink } from "./sync/convex-projection-sink";
import type { McpModelTool, ModelProvider, ModelProviderRouter } from "./model-provider";
import type { GovernanceGateway } from "./governed-tool-executor";
import { executeGovernedToolCall, summarizeToolCall } from "./governed-tool-executor";
import type { Policy } from "./policy";
import { classifyToolCall, evaluatePolicy } from "./policy";
import type { MachinePlatform } from "@relay/shared";
import { ScriptedModelProvider } from "./model-provider";
import { LocalModelRouter } from "./catalog-provider-router";
import { persistProviderEvent } from "./provider-event-gateway";
import { canaryRollbackReason, DEFAULT_ROLLBACK_THRESHOLDS, resolveMaxConcurrentRuns, type CanaryTelemetry, type RollbackThresholds } from "./runtime-mode";
import {
  executeCheckpointRestore,
  type CheckpointRestoreAdapterDeps,
} from "./adapters/checkpoint-restore-adapter";
import {
  executeCheckpointComparison,
  type CheckpointComparisonAdapterDeps,
} from "./adapters/checkpoint-comparison-adapter";
import {
  executeSubagent,
  type SubagentAdapterDeps,
} from "./adapters/subagent-adapter";
import {
  Tracer,
  incrementMetric,
  getMetrics,
  getHealth,
} from "@relay/local-store";
import type { TraceSpan } from "@relay/local-store";
import {
  scanForSecrets,
  sanitizeForProjection,
  THREAT_MODEL,
} from "@relay/local-store";
import {
  DaemonSupervisor,
  isCompatibleUpgrade,
  parseVersion,
} from "@relay/local-store";
import { SLO_DEFINITIONS } from "@relay/local-store";
import { storageAdmission } from "./storage-pressure";
import type { ToolCall } from "./tool-executor";
import {
  executeKernelAgenticTurn,
  type KernelTaskResult,
  resumeKernelAgenticTurn,
} from "./kernel-agentic-turn";
import { buildTurnPrompt, type ReviewComment } from "./agent-loop";
import { createCheckpoint } from "./checkpoints";
import { commitChanges, computeDiff, pushChanges, stageAll } from "./git-review";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KernelDaemonConfig = {
  daemonHome: string;
  deploymentUrl: string;
  deviceToken: string;
  heartbeatIntervalMs: number;
  /** Convex machine document ID — required to advance the outbound projection cursor. */
  machineId: string;
  machineName: string;
  pollIntervalMs?: number;
  /** Adapter deps — required for checkpoint and subagent commands. */
  adapterDeps?: {
    resolveProjectRoot(input: { repoPath: string; threadId: string }): Promise<string>;
    resolveSlashCommands?: (input: { projectPath: string }) => Promise<KernelSlashCommand[]>;
    governance?: GovernanceGateway;
    mcp?: KernelMcpAdapter;
    policy?: Policy;
    platform?: MachinePlatform;
  };
  /** Opt-in Codex app-server transport config (requires RELAY_CODEX_ENABLED=1). */
  codexTransport?: CodexTransportConfig & { enabled: boolean };
  /** Test-injection seam — overrides the real Convex-backed command source. */
  commandGateway?: CommandGateway;
  /** Test-injection seam — overrides the real Convex-backed projection sink. */
  projectionSink?: ProjectionSink;
  /** Test-injection seam for provider/control-boundary coverage. */
  providerRouter?: ModelProviderRouter;
  /** Command claim/renewal lease duration — overridable for kill-point tests. Default 30s. */
  commandLeaseDurationMs?: number;
  /** Heartbeat sink for bounded canary telemetry. */
  onCanaryTelemetry?: (telemetry: CanaryTelemetry) => Promise<unknown>;
  /** Stop/rollback hook invoked after an invariant violation is detected. */
  onCanaryRollback?: (input: { reason: string; telemetry: CanaryTelemetry }) => Promise<void>;
  /** Thresholds are injectable for deterministic canary kill-point tests. */
  rollbackThresholds?: RollbackThresholds;
};

type KernelMcpAdapter = {
  callTool(input: {
    arguments: Record<string, unknown>;
    name: string;
    onInputRequired?: (input: { prompts: unknown[] }) => Promise<Record<string, unknown>>;
    onTaskStatus?: (task: { id: string; status: string }) => Promise<void> | void;
    serverId: string;
  }): Promise<unknown>;
  listTools(): Promise<McpModelTool[]>;
  recordTaskStatus?: (input: { serverId: string; status: string; taskId: string; threadId: string }) => Promise<unknown>;
  requestInput?: (input: { onCreated?: (elicitationId: string) => Promise<void> | void; prompts: unknown[]; serverId: string; threadId: string; toolName: string }) => Promise<Record<string, unknown>>;
  resolveMcpInput?: (input: { elicitationId: string; responseJson: string }) => Promise<unknown>;
  cancelMcpInput?: (elicitationId: string) => Promise<unknown>;
};

type KernelSlashCommand = {
  argumentHint?: string;
  description: string;
  name: string;
  projectPath?: string;
  scope: "builtin" | "project" | "user" | "skill";
};

// ---------------------------------------------------------------------------
// Codex turn executor — bridges the Codex app-server into the kernel's event stream.
// Activated when codexTransport.enabled is true and RELAY_CODEX_ENABLED=1.
// ---------------------------------------------------------------------------

type CodexTurnExecution = {
  runId: string;
  turnId: string;
  prompt: string;
  codexAdapter: CodexSessionAdapter;
  runtime: LocalHarnessRuntime;
  threadId?: string;
  cwd?: string;
  onBeforeTerminal?: (succeeded: boolean, assistantText: string) => Promise<void>;
  onFirstToken?: (latencyMs: number) => void;
  onActive?: (threadId: string) => void;
  onInactive?: () => void;
};

const codexTurnTails = new WeakMap<CodexSessionAdapter, Promise<void>>();

export function executeTurnViaCodex(
  input: CodexTurnExecution,
): Promise<boolean> {
  const previous =
    codexTurnTails.get(input.codexAdapter) ?? Promise.resolve();
  const execution = previous.then(
    () => executeTurnViaCodexExclusive(input),
    () => executeTurnViaCodexExclusive(input),
  );
  codexTurnTails.set(
    input.codexAdapter,
    execution.then(
      () => undefined,
      () => undefined,
    ),
  );
  return execution;
}

async function executeTurnViaCodexExclusive({
  runId,
  turnId,
  prompt,
  codexAdapter,
  runtime,
  threadId,
  cwd,
  onBeforeTerminal,
  onFirstToken,
  onActive,
  onInactive,
}: CodexTurnExecution): Promise<boolean> {
  const turnStart = Date.now();
  let firstTokenEmitted = false;
  let settleTerminal!: (succeeded: boolean) => void;
  let rejectTerminal!: (error: unknown) => void;
  let terminalSettled = false;
  let expectedProviderThreadId: string | undefined;
  let expectedProviderTurnId: string | undefined;
  const pendingEvents: NormalizedEvent[] = [];
  let assistantText = "";
  const terminalNotification = new Promise<boolean>((resolve, reject) => {
    settleTerminal = resolve;
    rejectTerminal = reject;
  });
  let appendChain = Promise.resolve();
  const appendProviderEvent = (ev: NormalizedEvent) => {
    if (
      expectedProviderThreadId === undefined ||
      expectedProviderTurnId === undefined ||
      !isExpectedCodexEvent(
        ev,
        expectedProviderThreadId,
        expectedProviderTurnId,
      )
    ) {
      return;
    }
    appendChain = appendChain
      .then(async () => {
        const input = codexEventInput(
          `ev-codex-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          turnId,
          ev,
        );
        if (!input) return;
        const terminalEvent =
          ev.type === "turn.completed" ||
          ev.type === "turn.failed" ||
          ev.type === "turn.interrupted";
        if (ev.type === "assistant.delta" && typeof ev.payload.text === "string") assistantText += ev.payload.text;
        if (terminalEvent && onBeforeTerminal) await onBeforeTerminal(ev.type === "turn.completed", assistantText);
        const result = await persistProviderEvent(runtime, runId, input);
        if (!result.ok) {
          throw new Error(
            `Failed to append Codex ${ev.type}: ${result.reason}`,
          );
        }
        if (
          !firstTokenEmitted &&
          ev.type === "assistant.delta" &&
          onFirstToken
        ) {
          firstTokenEmitted = true;
          onFirstToken(Date.now() - turnStart);
        }
        if (terminalEvent) {
          terminalSettled = true;
          settleTerminal(ev.type === "turn.completed");
        }
        incrementMetric("eventsProcessed");
      })
      .catch((error) => {
        if (!terminalSettled) {
          terminalSettled = true;
          rejectTerminal(error);
        }
      });
  };
  const unsub = codexAdapter.onEvent((ev: NormalizedEvent) => {
    if (
      expectedProviderThreadId === undefined ||
      expectedProviderTurnId === undefined
    ) {
      pendingEvents.push(ev);
      return;
    }
    appendProviderEvent(ev);
  });

  let succeeded = false;
  let terminalTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (threadId) {
      await codexAdapter.resumeThread(threadId, {
        cwd,
        approvalPolicy: "never",
      });
    } else {
      await codexAdapter.startThread({
        cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      });
    }
    expectedProviderThreadId = codexAdapter.activeThreadId ?? undefined;
    if (!expectedProviderThreadId) {
      throw new Error("Codex did not provide a native thread ID");
    }
    onActive?.(expectedProviderThreadId);
    // Start the turn — Codex notifications stream back via onEvent
    const startResult = await codexAdapter.startTurn(
      expectedProviderThreadId,
      prompt,
    );
    expectedProviderTurnId = codexTurnIdFromStartResult(startResult);
    if (!expectedProviderTurnId) {
      throw new Error("Codex did not provide a native turn ID");
    }
    for (const event of pendingEvents.splice(0)) {
      appendProviderEvent(event);
    }
    terminalTimeout = setTimeout(() => {
      if (!terminalSettled) {
        terminalSettled = true;
        rejectTerminal(new Error("Timed out waiting for Codex terminal event"));
      }
    }, 10 * 60 * 1000);
    terminalTimeout.unref?.();
    succeeded = await terminalNotification;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistProviderEvent(runtime, runId, {
      eventId: `ev-codex-failed-${runId}-${Date.now()}`,
      type: "turn.failed",
      turnId: turnId as never,
      payload: { error: message },
    });
    console.error("Kernel daemon: Codex turn failed", message);
  } finally {
    if (terminalTimeout) clearTimeout(terminalTimeout);
    unsub();
    await appendChain;
    onInactive?.();
  }

  return succeeded;
}

function codexTurnIdFromStartResult(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const turn = (result as { turn?: unknown }).turn;
  if (turn === null || typeof turn !== "object") return undefined;
  const id = (turn as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isExpectedCodexEvent(
  event: NormalizedEvent,
  providerThreadId: string,
  providerTurnId: string,
): boolean {
  if (event.providerThreadId !== providerThreadId) return false;
  if (canonicalEventRequiresTurn(event.type)) {
    return event.providerTurnId === providerTurnId;
  }
  return (
    event.providerTurnId === undefined ||
    event.providerTurnId === providerTurnId
  );
}

function codexEventInput(
  eventId: string,
  turnId: string,
  event: NormalizedEvent,
): AppendEventInput | undefined {
  switch (event.type) {
    case "turn.started":
      // Relay already opened this turn before invoking the provider.
      return undefined;
    case "turn.steered":
    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted":
    case "assistant.delta":
    case "assistant.completed":
    case "activity.started":
    case "activity.delta":
    case "activity.completed":
    case "activity.failed":
      {
        const canonicalEvent = withoutCodexScope(event);
        return {
          eventId,
          ...canonicalEvent,
          turnId: turnId as never,
        };
      }
    default: {
      const canonicalEvent = withoutCodexScope(event);
      return {
        eventId,
        ...canonicalEvent,
      };
    }
  }
}

type CanonicalNormalizedEvent<TEvent extends NormalizedEvent> =
  TEvent extends NormalizedEvent
    ? Omit<TEvent, "providerThreadId" | "providerTurnId">
    : never;

function withoutCodexScope<TEvent extends NormalizedEvent>(
  event: TEvent,
): CanonicalNormalizedEvent<TEvent> {
  const {
    providerThreadId: _providerThreadId,
    providerTurnId: _providerTurnId,
    ...canonicalEvent
  } = event;
  return canonicalEvent as CanonicalNormalizedEvent<TEvent>;
}

// ---------------------------------------------------------------------------
// Turn executor — bridges the provider into the kernel's event stream
// ---------------------------------------------------------------------------

export type KernelTurnAwaitingApproval = {
  readonly approvalId: string;
  readonly status: "awaiting_approval";
};

type KernelApprovalContinuation = {
  readonly activityId: string;
  readonly call: ToolCall;
  readonly turnId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseKernelApprovalContinuation(json: string): KernelApprovalContinuation {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Kernel approval continuation is not valid JSON");
  }
  if (!isRecord(value) || !isRecord(value.call) || typeof value.activityId !== "string" || typeof value.turnId !== "string" || typeof value.call.kind !== "string") {
    throw new Error("Kernel approval continuation is malformed");
  }
  return { activityId: value.activityId, call: value.call as unknown as ToolCall, turnId: value.turnId };
}

export async function resumeKernelApproval({ approvalId, continuationJson, governance, platform, policy, resolution, root, runId, runtime, turnId }: {
  approvalId: string;
  continuationJson: string;
  governance: GovernanceGateway;
  platform: MachinePlatform;
  policy: Policy;
  resolution: "allow" | "deny";
  root: string;
  runId: string;
  runtime: LocalHarnessRuntime;
  turnId: string;
}): Promise<void> {
  const continuation = parseKernelApprovalContinuation(continuationJson);
  if (continuation.turnId !== turnId) throw new Error(`Approval ${approvalId} does not match turn ${turnId}`);
  let outputIndex = 0;
  try {
    const result = await executeGovernedToolCall({
      approvalResolution: resolution,
      call: continuation.call,
      governance,
      onCompleted: async () => undefined,
      onOutput: async (output) => {
        await persistProviderEvent(runtime, runId, {
          eventId: `ev-activity-delta-${runId}-${turnId}-${continuation.activityId}-${outputIndex++}`,
          type: "activity.delta",
          turnId: turnId as never,
          payload: { activityId: continuation.activityId as never, content: sanitizeForProjection(output).slice(0, 4_000) },
        });
      },
      platform,
      policy,
      root,
      threadId: runId,
    });
    await persistProviderEvent(runtime, runId, {
      eventId: `ev-activity-completed-${runId}-${turnId}-${continuation.activityId}`,
      type: "activity.completed",
      turnId: turnId as never,
      payload: {
        activityId: continuation.activityId as never,
        summary: result.kind === "refused" ? "Tool refused" : "Tool completed",
        result: { output: sanitizeForProjection(result.output).slice(0, 4_000), succeeded: result.kind === "executed" && result.succeeded },
      },
    });
  } catch (error) {
    await persistProviderEvent(runtime, runId, {
      eventId: `ev-activity-failed-${runId}-${turnId}-${continuation.activityId}`,
      type: "activity.failed",
      turnId: turnId as never,
      payload: { activityId: continuation.activityId as never, error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

export async function executeTurn({
  runId,
  turnId,
  prompt,
  provider,
  runtime,
  governance,
  policy,
  platform,
  root,
  projectPath,
  resolveProjectRoot,
  onFirstToken,
}: {
  runId: string;
  turnId: string;
  prompt: string;
  provider: ModelProvider;
  runtime: LocalHarnessRuntime;
  governance?: GovernanceGateway;
  policy?: Policy;
  platform?: MachinePlatform;
  root?: string;
  projectPath?: string;
  resolveProjectRoot?: (input: { repoPath: string; threadId: string }) => Promise<string>;
  onFirstToken?: (latencyMs: number) => void;
}): Promise<boolean | KernelTurnAwaitingApproval> {
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  const turnStart = Date.now();
  let firstTokenEmitted = false;
  let turnSucceeded = false;

  try {
    for await (const streamEvent of provider.streamReply({ prompt, signal })) {
      if (streamEvent.kind === "text") {
        // SLO: track time to first token
        if (!firstTokenEmitted && onFirstToken) {
          firstTokenEmitted = true;
          onFirstToken(Date.now() - turnStart);
        }
        // Sanitize output before storing
        const sanitizedText = sanitizeForProjection(streamEvent.text);
        const result = await persistProviderEvent(runtime, runId, {
          eventId: `ev-delta-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: "assistant.delta",
          turnId: turnId as never,
          payload: { text: sanitizedText },
        });
        if (!result.ok) {
          console.error("Kernel daemon: failed to append assistant.delta", result.reason);
        }
        incrementMetric("eventsProcessed");
      } else if (streamEvent.kind === "usage") {
        const result = await persistProviderEvent(runtime, runId, {
          eventId: `ev-usage-${runId}-${Date.now()}`,
          type: "usage.recorded",
          payload: {
            ...streamEvent.usage,
            thinkingTokens: streamEvent.usage.thinkingTokens ?? 0,
            modelId: DEFAULT_MODEL_ID,
          },
        });
        if (!result.ok) {
          console.error("Kernel daemon: failed to append usage.recorded", result.reason);
        }
        incrementMetric("eventsProcessed");
      }
    }

    if (provider.toolCalls) {
      let toolRoot = root;
      let toolIndex = 0;
      for await (const call of provider.toolCalls({ prompt })) {
        if (!governance || !policy || !platform) {
          throw new Error("Kernel tool execution requires governance, policy, and platform dependencies");
        }
        if (!toolRoot) {
          if (!resolveProjectRoot || !projectPath) {
            throw new Error("Kernel tool execution requires a resolvable project root");
          }
          toolRoot = await resolveProjectRoot({ repoPath: projectPath, threadId: runId });
        }

        const activityId = `activity-tool-${turnId}-${toolIndex++}`;
        let outputIndex = 0;
        const classification = classifyToolCall(call);
        await persistProviderEvent(runtime, runId, {
          eventId: `ev-activity-started-${runId}-${turnId}-${activityId}`,
          type: "activity.started",
          turnId: turnId as never,
          payload: { activityId: activityId as never, kind: "tool", toolName: call.kind },
        });

        if (evaluatePolicy({ ...classification, policy }) === "ask") {
          if (!governance.createApproval) {
            await persistProviderEvent(runtime, runId, {
              eventId: `ev-activity-failed-${runId}-${turnId}-${activityId}`,
              type: "activity.failed",
              turnId: turnId as never,
              payload: { activityId: activityId as never, error: "Kernel approval creation is not configured; tool refused" },
            });
            continue;
          }
          const approvalId = await governance.createApproval({
            ...classification,
            continuationJson: JSON.stringify({ call, activityId, turnId }),
            summary: summarizeToolCall(call),
            threadId: runId,
            turnId,
          });
          await persistProviderEvent(runtime, runId, {
            eventId: `ev-approval-requested-${runId}-${turnId}-${activityId}`,
            type: "approval.requested",
            turnId: turnId as never,
            payload: {
              approvalId: approvalId as never,
              capability: classification.capability,
              risk: classification.risk,
              details: summarizeToolCall(call),
            },
          });
          return { approvalId, status: "awaiting_approval" };
        }

        try {
          const result = await executeGovernedToolCall({
            call,
            governance,
            onCompleted: async () => undefined,
            onOutput: async (output) => {
              await persistProviderEvent(runtime, runId, {
                eventId: `ev-activity-delta-${runId}-${turnId}-${activityId}-${outputIndex++}`,
                type: "activity.delta",
                turnId: turnId as never,
                payload: { activityId: activityId as never, content: sanitizeForProjection(output).slice(0, 4_000) },
              });
            },
            platform,
            policy,
            root: toolRoot,
            threadId: runId,
          });
          await persistProviderEvent(runtime, runId, {
            eventId: `ev-activity-completed-${runId}-${turnId}-${activityId}`,
            type: "activity.completed",
            turnId: turnId as never,
            payload: {
              activityId: activityId as never,
              summary: result.kind === "refused" ? "Tool refused" : "Tool completed",
              result: { output: sanitizeForProjection(result.output).slice(0, 4_000), succeeded: result.kind === "executed" && result.succeeded },
            },
          });
        } catch (error) {
          await persistProviderEvent(runtime, runId, {
            eventId: `ev-activity-failed-${runId}-${turnId}-${activityId}`,
            type: "activity.failed",
            turnId: turnId as never,
            payload: { activityId: activityId as never, error: error instanceof Error ? error.message : String(error) },
          });
          throw error;
        }
      }
    }
    turnSucceeded = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistProviderEvent(runtime, runId, {
      eventId: `ev-failed-${runId}-${Date.now()}`,
      type: "turn.failed",
      turnId: turnId as never,
      payload: { error: message },
    });
    console.error("Kernel daemon: turn failed", message);
  }

  if (turnSucceeded) {
    await persistProviderEvent(runtime, runId, {
      eventId: `ev-completed-${runId}-${Date.now()}`,
      type: "turn.completed",
      turnId: turnId as never,
      payload: {},
    });
  } else {
    await persistProviderEvent(runtime, runId, {
      eventId: `ev-failed-terminal-${runId}-${Date.now()}`,
      type: "turn.failed",
      turnId: turnId as never,
      payload: { error: "Provider turn failed" },
    });
  }

  return turnSucceeded;
}

/**
 * Temporary boundary for legacy adapter results that have not yet moved to
 * the versioned canonical-event schemas scheduled in Increment 1 batch 2.
 */
function appendAdapterEvent(
  runtime: LocalHarnessRuntime,
  runId: string,
  input: {
    readonly eventId: string;
    readonly type: AppendEventInput["type"];
    readonly payload: Record<string, unknown>;
  },
): Promise<AppendEventResult> {
  const payloadError = canonicalEventPayloadError(input.type, input.payload);
  if (payloadError) return Promise.resolve({ ok: false, reason: payloadError });
  const activeTurnId = runtime.getSnapshotByRunId(runId)?.activeTurnId;
  if (canonicalEventRequiresTurn(input.type) && !activeTurnId) {
    return Promise.resolve({
      ok: false,
      reason: `${input.type} requires an active Relay turn`,
    });
  }
  const validated = {
    ...input,
    ...(activeTurnId === undefined ? {} : { turnId: activeTurnId }),
  } as AppendEventInput;
  return persistProviderEvent(runtime, runId, validated);
}

function canonicalizeSubagentEvents(
  events: ReadonlyArray<{ eventId: string; payload: Record<string, unknown>; type: string }>,
  runId: string,
  turnId: string,
): CanonicalEventDraft[] {
  const supported = new Set(["activity.started", "activity.delta", "activity.completed", "activity.failed", "checkpoint.captured", "usage.recorded"]);
  return events.flatMap((event) => {
    if (!supported.has(event.type)) return [];
    return [{
      causationId: event.eventId as never,
      correlationId: `corr-subagent-${runId}-${turnId}` as never,
      eventId: event.eventId as never,
      payload: event.payload,
      runId: runId as never,
      turnId: turnId as never,
      type: event.type as CanonicalEventDraft["type"],
    } as CanonicalEventDraft];
  });
}

// ---------------------------------------------------------------------------
// Command lease renewal
// ---------------------------------------------------------------------------

/**
 * Start renewing a claimed command's lease at roughly a third of its
 * duration, for the lifetime of an external effect. Returns a stop function
 * that must be called once the effect finishes (success or failure) to
 * release the timer. `onLost` fires whenever a renewal attempt fails —
 * because the lease expired and was reclaimed by another worker, or is held
 * by a different generation — and the caller must treat that as fencing:
 * any in-flight completion for this command is no longer safe to commit.
 */
export function startLeaseRenewal(input: {
  commandGateway: CommandGateway;
  commandId: string;
  deviceToken: string;
  leaseGeneration: number;
  leaseDurationMs: number;
  onLost: (error: unknown) => void;
}): () => void {
  const renewalIntervalMs = Math.max(1, Math.floor(input.leaseDurationMs / 3));
  const timer = setInterval(() => {
    void input.commandGateway
      .renewLease({
        commandId: input.commandId,
        deviceToken: input.deviceToken,
        leaseDurationMs: input.leaseDurationMs,
        leaseGeneration: input.leaseGeneration,
      })
      .catch(input.onLost);
  }, renewalIntervalMs);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Projection publisher
// ---------------------------------------------------------------------------

export type ProjectionTelemetry = {
  backlog: number;
  oldestPendingAgeMs: number;
  retries: number;
  conflicts: number;
  cursorLag: number;
};

/**
 * Publish the durable local outbox to Convex in per-run sequence order.
 * Rows are claimed under a lease so a crashed publisher's claim is
 * reclaimable once the lease expires; local rows are acknowledged only
 * after Convex durably confirms the batch, and the outbound cursor
 * advances only after that acknowledgement. A batch failure (lost
 * response, network error, backend restart) leaves the batch leased and
 * unacknowledged — it converges on the next flush once the lease expires,
 * and exact-duplicate republication is a no-op on the Convex side.
 */
export async function publishProjectionOutbox({
  deviceToken,
  runtime,
  projectionSink,
  machineId,
  telemetry,
  leaseDurationMs = 60_000,
  limit = 100,
}: {
  deviceToken: string;
  runtime: LocalHarnessRuntime;
  projectionSink: ProjectionSink;
  machineId: string;
  telemetry: ProjectionTelemetry;
  /** Outbox claim lease duration — overridable for kill-point/expiry tests. */
  leaseDurationMs?: number;
  limit?: number;
}): Promise<void> {
  const batch = runtime.claimProjectionOutbox({
    owner: machineId,
    leaseDurationMs,
    limit,
  });

  if (batch.length > 0) {
    const events: Array<{
      eventId: string;
      occurredAt: number;
      payloadJson: string;
      projectId: string;
      runId: string;
      sequence: number;
      type: string;
    }> = [];
    const publishableIds: number[] = [];
    const projectIdByRun = new Map<string, string | null>();

    for (const row of batch) {
      let projectId = projectIdByRun.get(row.runId);
      if (projectId === undefined) {
        const snapshot = runtime.getSnapshotByRunId(row.runId);
        projectId = (snapshot?.projectId as string | undefined) ?? null;
        projectIdByRun.set(row.runId, projectId);
      }
      if (!projectId) {
        // No resolvable run snapshot yet — leave unacknowledged; the lease
        // expires and this row is reclaimed once the run snapshot exists.
        continue;
      }
      events.push({
        eventId: row.eventId,
        occurredAt: row.occurredAt,
        payloadJson: row.payloadJson,
        projectId,
        runId: row.runId,
        sequence: row.sequence,
        type: row.type,
      });
      publishableIds.push(row.id);
    }

    if (events.length > 0) {
      try {
        await projectionSink.appendEvents({ events, deviceToken });
        runtime.acknowledgeProjectionOutbox(publishableIds);
        const maxId = Math.max(...publishableIds);
        try {
          await projectionSink.advanceCursor({
            direction: "outbound",
            machineId,
            sequence: maxId,
            deviceToken,
          });
        } catch (cursorError) {
          // Cursor advance is best-effort observability; local rows are
          // already durably acknowledged, so this never re-publishes.
          console.error("Kernel daemon: projection cursor advance failed", cursorError);
        }
      } catch (error) {
        telemetry.retries++;
        const message = error instanceof Error ? error.message : String(error);
        if (/conflict/i.test(message) || /gap/i.test(message)) telemetry.conflicts++;
        console.error("Kernel daemon: projection outbox publish failed; retrying after lease expiry", message);
      }
    }
  }

  const pending = runtime.countPendingProjectionOutbox();
  telemetry.backlog = pending.count;
  telemetry.oldestPendingAgeMs = pending.oldestOccurredAt ? Date.now() - pending.oldestOccurredAt : 0;
  telemetry.cursorLag = pending.count;
}

export async function flushProjections({
  deviceToken,
  runtime,
  projectionSink,
  machineId,
  telemetry,
}: {
  deviceToken: string;
  runtime: LocalHarnessRuntime;
  projectionSink: ProjectionSink;
  machineId: string;
  telemetry: ProjectionTelemetry;
}): Promise<void> {
  try {
    await publishProjectionOutbox({ deviceToken, runtime, projectionSink, machineId, telemetry });
  } catch (error) {
    console.error("Kernel daemon: projection outbox flush failed", error);
  }

  const runs = runtime.listRuns();
  for (const run of runs) {
    try {
      const snapshot = runtime.getSnapshotByRunId(run.runId);
      if (!snapshot) continue;

      await projectionSink.upsertSnapshot({
        projectId: snapshot.projectId as string,
        runId: snapshot.runId as string,
        sequence: snapshot.sequence,
        snapshotJson: JSON.stringify(snapshot),
        deviceToken,
      });
    } catch (error) {
      // A run can advance locally after the outbox batch is claimed, so
      // Convex may reject the snapshot until the next flush publishes the
      // newly-created event. One run's rejection must not block others.
      const message = error instanceof Error ? error.message : String(error);
      if (!/has not been published/.test(message)) {
        console.error("Kernel daemon: snapshot flush failed for run", run.runId, message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// KernelDaemon
// ---------------------------------------------------------------------------

export class KernelDaemon {
  private runtime!: LocalHarnessRuntime;
  private provider!: ModelProviderRouter;
  private commandGateway!: CommandGateway;
  private projectionSink!: ProjectionSink;
  private codexAdapter: CodexSessionAdapter | null = null;
  private readonly projectPathByRun = new Map<string, string>();
  private shuttingDown = false;
  private tracer = new Tracer();
  private supervisor!: DaemonSupervisor;
  private firstTokenLatencies: number[] = [];
  private readonly activeKernelTurns = new Map<string, {
    readonly abortController: AbortController;
    readonly steering: string[];
  }>();
  private readonly activeCodexTurns = new Map<string, { readonly threadId: string }>();
  private mcpElicitationSequence = 0;

  // Canary telemetry — collected during command processing, reported via heartbeat.
  private canaryTelemetry = {
    activeLeases: 0,
    duplicateCommands: 0,
    crossOwnerResults: 0,
    pendingEffects: 0,
    projectionBacklog: 0,
    projectionGaps: 0,
    projectionDivergences: 0,
    authFailures: 0,
    sandboxViolations: 0,
    recoverableFailures: 0,
    unrecoverableFailures: 0,
    fallbackActivations: 0,
  };
  private canaryRollbackTriggered = false;

  // Outbox publish observability — backlog, oldest pending age, retries,
  // conflicts, and cursor lag, per the ordered-projection ticket.
  private projectionTelemetry: ProjectionTelemetry = {
    backlog: 0,
    oldestPendingAgeMs: 0,
    retries: 0,
    conflicts: 0,
    cursorLag: 0,
  };

  /** Outbox publish observability snapshot, for heartbeat reporting and tests. */
  getProjectionTelemetry(): Readonly<ProjectionTelemetry> {
    return { ...this.projectionTelemetry };
  }

  getCanaryTelemetry(): CanaryTelemetry {
    return this.canarySnapshot();
  }

  private assertProviderEventOwnership(
    events: ReadonlyArray<unknown>,
    runId: string,
  ): void {
    const foreignCount = events.filter((event) => {
      if (typeof event !== "object" || event === null || !("runId" in event)) return false;
      const eventRunId = (event as { readonly runId?: unknown }).runId;
      return typeof eventRunId === "string" && eventRunId !== runId;
    }).length;
    if (foreignCount > 0) {
      this.canaryTelemetry.crossOwnerResults += foreignCount;
      throw new Error(`Provider returned ${foreignCount} event(s) owned by another run`);
    }
  }

  constructor(private readonly config: KernelDaemonConfig) {}

  private async createKernelToolContext(input: {
    modelId?: string;
    projectPath?: string;
    runId: string;
    turnId: string;
  }): Promise<{
    onMcp?: (call: Extract<ToolCall, { kind: "mcp" }>) => Promise<unknown>;
    onTask?: (call: Extract<ToolCall, { kind: "task" }>) => Promise<KernelTaskResult>;
    tools: McpModelTool[];
  }> {
    const mcp = this.config.adapterDeps?.mcp;
    const mcpTaskActivities = new Set<string>();
    const onMcp = mcp
      ? async (call: Extract<ToolCall, { kind: "mcp" }>) => mcp.callTool({
          ...call,
          onInputRequired: mcp.requestInput
            ? async ({ prompts }) => {
                const activityId = `mcp-elicitation-${input.runId}-${input.turnId}-${++this.mcpElicitationSequence}`;
                let elicitationId: string | undefined;
                const promptsJson = JSON.stringify(prompts).slice(0, 100_000);
                try {
                  const response = await mcp.requestInput!({
                    onCreated: async (createdId) => {
                      elicitationId = createdId;
                      const started = await appendAdapterEvent(this.runtime, input.runId, {
                        eventId: `${activityId}:started`,
                        type: "activity.started",
                        payload: {
                          activityId,
                          elicitationId: createdId,
                          kind: "mcp:elicitation",
                          promptsJson,
                          serverId: call.serverId,
                          toolName: call.name,
                        },
                      });
                      if (!started.ok) throw new Error(`Failed to append MCP elicitation event: ${started.reason}`);
                    },
                    prompts,
                    serverId: call.serverId,
                    threadId: input.runId,
                    toolName: call.name,
                  });
                  if (elicitationId) {
                    const completed = await appendAdapterEvent(this.runtime, input.runId, {
                      eventId: `${activityId}:completed`,
                      type: "activity.completed",
                      payload: { activityId, elicitationId, kind: "mcp:elicitation", summary: "Response submitted" },
                    });
                    if (!completed.ok) throw new Error(`Failed to append MCP elicitation completion: ${completed.reason}`);
                  }
                  return response;
                } catch (error) {
                  if (elicitationId) {
                    const failed = await appendAdapterEvent(this.runtime, input.runId, {
                      eventId: `${activityId}:failed`,
                      type: "activity.failed",
                      payload: { activityId, elicitationId, error: error instanceof Error ? error.message : String(error), kind: "mcp:elicitation" },
                    });
                    if (!failed.ok) console.error("Kernel daemon: failed to append MCP elicitation failure", failed.reason);
                  }
                  throw error;
                }
              }
            : undefined,
          onTaskStatus: async (task) => {
            const taskId = requireBoundedString(task.id, "MCP task id", 200);
            const status = requireBoundedString(task.status, "MCP task status", 200);
            const activityId = `mcp-task-${input.runId}-${input.turnId}-${safeMcpTaskId(taskId)}`;
            if (!mcpTaskActivities.has(activityId)) {
              mcpTaskActivities.add(activityId);
              const started = await appendAdapterEvent(this.runtime, input.runId, {
                eventId: `${activityId}:started`,
                type: "activity.started",
                payload: { activityId, kind: "mcp:task", serverId: call.serverId, taskId, toolName: call.name },
              });
              if (!started.ok) throw new Error(`Failed to append MCP task start: ${started.reason}`);
            }
            const terminal = status === "completed" || status === "failed" || status === "cancelled";
            const update = await appendAdapterEvent(this.runtime, input.runId, terminal
              ? {
                  eventId: `${activityId}:${status}`,
                  type: status === "completed" ? "activity.completed" : "activity.failed",
                  payload: status === "completed"
                    ? { activityId, kind: "mcp:task", serverId: call.serverId, summary: "MCP task completed", taskId, toolName: call.name }
                    : { activityId, error: `MCP task ${status}`, kind: "mcp:task", serverId: call.serverId, taskId, toolName: call.name },
                }
              : {
                  eventId: `${activityId}:status:${status}`,
                  type: "activity.delta",
                  payload: { activityId, content: status, kind: "mcp:task", serverId: call.serverId, taskId, toolName: call.name },
                });
            if (!update.ok) throw new Error(`Failed to append MCP task status: ${update.reason}`);
          },
        })
      : undefined;
    const resolveProjectRoot = this.config.adapterDeps?.resolveProjectRoot;
    const onTask = resolveProjectRoot && input.projectPath
      ? async (call: Extract<ToolCall, { kind: "task" }>) => {
          const task = await this.runtime.runWorkflow({
            runId: input.runId,
            workflowKind: "subagent",
            task: {
              taskId: `task-${input.runId}-${input.turnId}-${call.role}` as never,
              runId: input.runId as never,
              role: "builder",
              roleName: call.role,
              objective: call.task,
              dependencies: [],
              capabilityCeiling: "workspace-write",
              capabilities: call.capabilities,
              contextBudget: 8_000,
              workspaceMode: "isolated-worktree",
              state: "ready",
              attempt: 0,
              maxAttempts: 3,
              projectPath: input.projectPath,
              threadId: input.runId,
              turnId: input.turnId,
              modelId: input.modelId,
            },
          });
          const result = task?.result as { readonly status?: string; readonly summary?: string; readonly error?: string } | undefined;
          return {
            output: JSON.stringify({ artifacts: [], findings: [], status: result?.status ?? "failed", summary: result?.summary ?? result?.error ?? "Subagent completed" }),
          };
        }
      : undefined;
    return { onMcp, onTask, tools: mcp ? await mcp.listTools() : [] };
  }

  async start(): Promise<void> {
    const startSpan = this.tracer.startSpan("daemon.start");

    // 1. Build the provider and reactor composition before opening the local
    // store, so the runtime receives the complete registry snapshot.
    const dbPath = join(this.config.daemonHome, "relay-kernel.sqlite");
    const reactors = new MutableReactorRegistry();

    // 2. Create the provider
    const fallback = new ScriptedModelProvider({
      chunks: ["Relay kernel received your message."],
    });
    this.provider = this.config.providerRouter ?? new LocalModelRouter({
      env: Bun.env as Record<string, string | undefined>,
      fallbackProvider: fallback,
    });

    // 2b. Create optional Codex session adapter
    if (this.config.codexTransport?.enabled && Bun.env.RELAY_CODEX_ENABLED === "1") {
      this.codexAdapter = createCodexSessionAdapter({
        transport: {
          codexPath: this.config.codexTransport.codexPath,
          clientInfo: this.config.codexTransport.clientInfo,
          capabilities: this.config.codexTransport.capabilities,
        },
      });
      console.info("Kernel daemon: Codex app-server transport enabled");
    }

    // 2c. Register the provider reactor — bridges the daemon's provider router
    // and optional Codex adapter into the orchestration engine's effect system.
    // When the decider emits a provider.send_turn effect, the engine invokes
    // this reactor to execute the turn and stream canonical events back.
    const codex = this.codexAdapter;
    const codexEnabled = codex && Bun.env.RELAY_CODEX_ENABLED === "1";
    const providerReactor: EffectReactor = {
      execute: async (effect, context) => {
        if (effect.intent.kind !== "provider.send_turn") {
          throw new Error(`Unexpected effect kind: ${effect.intent.kind}`);
        }
        const { runId } = effect;
        const { turnId, prompt } = effect.intent;
        const providerIntent = effect.intent as Extract<EffectIntent, { kind: "provider.send_turn" }>;
        const reviewComments = providerIntent.reviewComments ?? [];
        const providerPrompt = buildTurnPrompt({ content: prompt, reviewComments: reviewComments as ReviewComment[] });
        const projectPath = this.projectPathByRun.get(runId);
        const root = projectPath && this.config.adapterDeps?.resolveProjectRoot
          ? await this.config.adapterDeps.resolveProjectRoot({ repoPath: projectPath, threadId: runId })
          : undefined;
        const beforeCheckpoint = root ? await captureKernelCheckpoint({ root, runId, turnId, phase: "before" }) : undefined;
        const runSnapshot = await this.runtime.snapshot({ runId });
        const planPhase = runSnapshot.planPhase;
        const modelId = planPhase === "planning"
          ? runSnapshot.planModelId ?? runSnapshot.modelId ?? DEFAULT_MODEL_ID
          : planPhase === "building"
            ? runSnapshot.buildModelId ?? runSnapshot.modelId ?? DEFAULT_MODEL_ID
            : runSnapshot.modelId ?? DEFAULT_MODEL_ID;
        const thinkingLevel = runSnapshot.thinkingLevel ?? "none";
        const planPrompt = kernelPlanPrompt({ phase: planPhase, approvedContent: runSnapshot.plan?.content });
        const effectivePrompt = [planPrompt, providerPrompt].filter(Boolean).join("\n\n");
        const kernelToolContext = codexEnabled
          ? undefined
          : await this.createKernelToolContext({ modelId, projectPath, runId, turnId });
        if (codexEnabled && codex) {
          if (beforeCheckpoint) {
            const result = await persistProviderEvent(this.runtime, runId, {
              ...beforeCheckpoint,
            });
            if (!result.ok) throw new Error(`Failed to append Codex before checkpoint: ${result.reason}`);
          }
          await executeTurnViaCodex({
            codexAdapter: codex,
            prompt: effectivePrompt,
            runId,
            runtime: this.runtime,
            turnId,
            cwd: root,
            threadId: runSnapshot.providerSession?.providerThreadId,
            onBeforeTerminal: async (succeeded, assistantText) => {
              if (root) {
                const afterCheckpoint = await captureKernelCheckpoint({ root, runId, turnId, phase: "after" });
                const result = await persistProviderEvent(this.runtime, runId, {
                  ...afterCheckpoint,
                });
                if (!result.ok) throw new Error(`Failed to append Codex after checkpoint: ${result.reason}`);
                const diff = await captureKernelDiff({ root, runId, turnId });
                const diffResult = await persistProviderEvent(this.runtime, runId, diff);
                if (!diffResult.ok) throw new Error(`Failed to append Codex workspace diff: ${diffResult.reason}`);
              }
              if (succeeded) {
                if (planPhase === "planning") {
                  const planResult = await persistProviderEvent(this.runtime, runId, planEvent({
                    buildModelId: runSnapshot.buildModelId,
                    content: assistantText,
                    phase: "review",
                    planModelId: runSnapshot.planModelId,
                    revision: 0,
                    runId,
                    status: "draft",
                    turnId,
                  }, "codex"));
                  if (!planResult.ok) throw new Error(`Failed to append Codex plan artifact: ${planResult.reason}`);
                } else if (planPhase === "building") {
                  const planResult = await persistProviderEvent(this.runtime, runId, planEvent({ phase: "complete", runId, turnId }, "codex"));
                  if (!planResult.ok) throw new Error(`Failed to complete Codex plan: ${planResult.reason}`);
                }
                for (const resolution of reviewCommentResolutionEvents({
                  commentIds: providerIntent.reviewCommentIds ?? reviewComments.map((comment) => comment.commentId),
                  runId,
                  turnId,
                })) {
                  const result = await persistProviderEvent(this.runtime, runId, resolution);
                  if (!result.ok) throw new Error(`Failed to append Codex review resolution: ${result.reason}`);
                }
              }
            },
            onActive: (threadId) => this.activeCodexTurns.set(activeTurnKey(runId, turnId), { threadId }),
            onInactive: () => this.activeCodexTurns.delete(activeTurnKey(runId, turnId)),
          });
        } else {
          const turnProvider = this.provider.resolveTurn?.({ modelId, thinkingLevel });
          if (!turnProvider) {
            throw new Error("Kernel provider router does not support agentic turns");
          }
          const activeTurn = {
            abortController: new AbortController(),
            steering: [],
          };
          this.activeKernelTurns.set(activeTurnKey(runId, turnId), activeTurn);
          const signal = linkAbortSignals(context.signal, activeTurn.abortController.signal);
          try {
            const result = await executeKernelAgenticTurn({
              governance: this.config.adapterDeps?.governance ?? unavailableGovernance(),
              messages: [{ content: providerPrompt, role: "user" }],
              platform: this.config.adapterDeps?.platform ?? "linux",
              policy: this.config.adapterDeps?.policy ?? { rules: [] },
              provider: turnProvider,
              root,
              runId,
              signal: signal.signal,
              system: planPrompt,
              turnId,
              planPhase,
              tools: kernelToolContext?.tools,
              onMcp: kernelToolContext?.onMcp,
              onTask: kernelToolContext?.onTask,
              reviewCommentIds: providerIntent.reviewCommentIds ?? reviewComments.map((comment) => comment.commentId),
              claimSteering: async () => activeTurn.steering.splice(0),
            });
            const afterCheckpoint = root && !result.pending ? await captureKernelCheckpoint({ root, runId, turnId, phase: "after" }) : undefined;
            const workspaceDiff = root && !result.pending ? await captureKernelDiff({ root, runId, turnId }) : undefined;
            const terminalEvent = result.events.at(-1);
            const planEvents = terminalEvent?.type === "turn.completed" && planPhase === "planning"
              ? [planEvent({
                buildModelId: runSnapshot.buildModelId,
                content: assistantTextFromEvents(result.events),
                phase: "review",
                planModelId: runSnapshot.planModelId,
                revision: 0,
                runId,
                status: "draft",
                turnId,
              }, "local")]
              : terminalEvent?.type === "turn.completed" && planPhase === "building"
                ? [planEvent({ phase: "complete", runId, turnId }, "local")]
                : [];
            const providerEvents = terminalEvent?.type === "turn.completed" || terminalEvent?.type === "turn.failed" || terminalEvent?.type === "turn.interrupted"
              ? result.events.slice(0, -1)
              : result.events;
            const reviewResolutions = terminalEvent?.type === "turn.completed"
              ? reviewCommentResolutionEvents({
                commentIds: providerIntent.reviewCommentIds ?? reviewComments.map((comment) => comment.commentId),
                runId,
                turnId,
              })
              : [];
            const normalizedEvents = [
              ...(beforeCheckpoint ? [beforeCheckpoint] : []),
              ...providerEvents,
              ...(afterCheckpoint ? [afterCheckpoint] : []),
              ...(workspaceDiff ? [workspaceDiff] : []),
              ...planEvents,
              ...reviewResolutions,
              ...(terminalEvent ? [terminalEvent] : []),
            ];
            this.assertProviderEventOwnership(normalizedEvents, runId);
            return normalizedEvents.map((normalizedEvent) => ({
              type: "provider.event" as const,
              payload: {
                providerInstanceId: "provider-local" as never,
                normalizedEvent,
              },
            }));
          } finally {
            signal.dispose();
            this.activeKernelTurns.delete(activeTurnKey(runId, turnId));
          }
        }
        const afterCheckpoint = root ? await captureKernelCheckpoint({ root, runId, turnId, phase: "after" }) : undefined;
        const workspaceDiff = root ? await captureKernelDiff({ root, runId, turnId }) : undefined;
        const normalizedEvents = [
          ...(beforeCheckpoint ? [beforeCheckpoint] : []),
          ...(afterCheckpoint ? [afterCheckpoint] : []),
          ...(workspaceDiff ? [workspaceDiff] : []),
        ];
        this.assertProviderEventOwnership(normalizedEvents, runId);
        return normalizedEvents.map((normalizedEvent) => ({
          type: "provider.event" as const,
          payload: { providerInstanceId: "provider-local" as never, normalizedEvent },
        }));
      },
      recover: async (effect, context) => providerReactor.execute(effect, context),
    };
    reactors.register("provider.send_turn", providerReactor);

    const approvalReactor: EffectReactor = {
      execute: async (effect, context) => {
        if (effect.intent.kind !== "provider.resolve_approval") {
          throw new Error(`Unexpected effect kind: ${effect.intent.kind}`);
        }
        const governance = this.config.adapterDeps?.governance;
        const policy = this.config.adapterDeps?.policy;
        const platform = this.config.adapterDeps?.platform;
        const resolveProjectRoot = this.config.adapterDeps?.resolveProjectRoot;
        if (!governance?.getApproval || !governance || !policy || !platform || !resolveProjectRoot) {
          throw new Error("Kernel approval resolution requires governance, policy, platform, and workspace dependencies");
        }
        const approval = await governance.getApproval({ approvalId: effect.intent.approvalId });
        if (!approval || approval.threadId !== effect.runId) {
          throw new Error(`Approval ${effect.intent.approvalId} is not available for run ${effect.runId}`);
        }
        if (approval.decision !== effect.intent.resolution) {
          throw new Error(`Approval ${effect.intent.approvalId} resolved as ${approval.decision}, not ${effect.intent.resolution}`);
        }
        if (!approval.continuationJson || !effect.intent.turnId) {
          throw new Error(`Approval ${effect.intent.approvalId} has no resumable kernel continuation`);
        }
        const projectPath = this.projectPathByRun.get(effect.runId);
        if (!projectPath) throw new Error(`Run ${effect.runId} has no authorized project path`);
        const root = await resolveProjectRoot({ repoPath: projectPath, threadId: effect.runId });
        const approvalSnapshot = await this.runtime.snapshot({ runId: effect.runId });
        const turnProvider = this.provider.resolveTurn?.({ modelId: approvalSnapshot.modelId ?? DEFAULT_MODEL_ID, thinkingLevel: approvalSnapshot.thinkingLevel ?? "none" });
        if (!turnProvider) throw new Error("Kernel provider router does not support agentic turns");
        const kernelToolContext = await this.createKernelToolContext({
          modelId: approvalSnapshot.modelId,
          projectPath,
          runId: effect.runId,
          turnId: effect.intent.turnId,
        });
        const activeTurn = {
          abortController: new AbortController(),
          steering: [],
        };
        this.activeKernelTurns.set(activeTurnKey(effect.runId, effect.intent.turnId), activeTurn);
        const signal = linkAbortSignals(context.signal, activeTurn.abortController.signal);
        try {
          const result = await resumeKernelAgenticTurn({
            continuationJson: approval.continuationJson,
            governance,
            platform,
            policy,
            provider: turnProvider,
            resolution: effect.intent.resolution,
            root,
            runId: effect.runId,
            signal: signal.signal,
            turnId: effect.intent.turnId,
            tools: kernelToolContext.tools,
            onMcp: kernelToolContext.onMcp,
            onTask: kernelToolContext.onTask,
            claimSteering: async () => activeTurn.steering.splice(0),
          });
          const afterCheckpoint = await captureKernelCheckpoint({ root, runId: effect.runId, turnId: effect.intent.turnId, phase: "after" });
          const workspaceDiff = await captureKernelDiff({ root, runId: effect.runId, turnId: effect.intent.turnId });
          const reviewResolutions = result.reviewCommentIds
            ? reviewCommentResolutionEvents({ commentIds: result.reviewCommentIds, runId: effect.runId, turnId: effect.intent.turnId })
            : [];
          const normalizedEvents = [...result.events, afterCheckpoint, workspaceDiff, ...reviewResolutions];
          this.assertProviderEventOwnership(normalizedEvents, effect.runId);
          return normalizedEvents.map((normalizedEvent) => ({
            type: "provider.event" as const,
            payload: {
              providerInstanceId: "provider-local" as never,
              normalizedEvent,
            },
          }));
        } finally {
          signal.dispose();
          this.activeKernelTurns.delete(activeTurnKey(effect.runId, effect.intent.turnId));
        }
      },
      recover: async (effect, context) => {
        if (context.signal.aborted) throw new Error("Approval effect cancelled");
        return approvalReactor.execute(effect, context);
      },
    };
    reactors.register("provider.resolve_approval", approvalReactor);

    // Register no-op reactors for provider lifecycle, workspace, checkpoint,
    // approval, and tool effects — these are routed through the existing
    // adapter infrastructure and don't need new side effects in the daemon.
    const noopReactor: EffectReactor = {
      execute: async () => [],
      recover: async () => [],
    };
    for (const kind of ["provider.start_session", "provider.resume_session", "provider.stop_session", "workspace.create", "workspace.reconcile", "checkpoint.restore", "tool.execute"] as const) {
      reactors.register(kind, noopReactor);
    }

    reactors.register("provider.steer_turn", {
      execute: async (effect) => {
        if (effect.intent.kind !== "provider.steer_turn") throw new Error(`Unexpected effect kind: ${effect.intent.kind}`);
        this.activeKernelTurns.get(activeTurnKey(effect.runId, effect.intent.turnId))?.steering.push(effect.intent.steering);
        const codexTurn = this.activeCodexTurns.get(activeTurnKey(effect.runId, effect.intent.turnId));
        if (codexTurn && codex) await codex.steerTurn(codexTurn.threadId, effect.intent.steering);
        return [];
      },
      recover: async (effect, context) => {
        if (context.signal.aborted) return [];
        return reactors.build()["provider.steer_turn"]!.execute(effect, context);
      },
    });
    reactors.register("provider.interrupt_turn", {
      execute: async (effect) => {
        if (effect.intent.kind !== "provider.interrupt_turn") throw new Error(`Unexpected effect kind: ${effect.intent.kind}`);
        this.activeKernelTurns.get(activeTurnKey(effect.runId, effect.intent.turnId))?.abortController.abort(new DOMException(effect.intent.reason, "AbortError"));
        const codexTurn = this.activeCodexTurns.get(activeTurnKey(effect.runId, effect.intent.turnId));
        if (codexTurn && codex) await codex.interruptTurn(codexTurn.threadId, effect.intent.reason);
        return [];
      },
      recover: async (effect, context) => {
        if (context.signal.aborted) return [];
        return reactors.build()["provider.interrupt_turn"]!.execute(effect, context);
      },
    });
    reactors.register("checkpoint.capture", {
      execute: async (effect) => {
        if (effect.intent.kind !== "checkpoint.capture") throw new Error(`Unexpected effect kind: ${effect.intent.kind}`);
        const projectPath = this.projectPathByRun.get(effect.runId);
        const resolveProjectRoot = this.config.adapterDeps?.resolveProjectRoot;
        if (!projectPath || !resolveProjectRoot) return [];
        const root = await resolveProjectRoot({ repoPath: projectPath, threadId: effect.runId });
        const checkpoint = await createCheckpoint({ root, threadId: effect.runId, turnId: effect.intent.turnId });
        return [{
          type: "provider.event" as const,
          payload: {
            providerInstanceId: "provider-local" as never,
            normalizedEvent: {
              causationId: effect.commandId as never,
              correlationId: `corr-${effect.effectId}` as never,
              eventId: `ev-checkpoint-${effect.runId}-${effect.intent.turnId}` as never,
              payload: { checkpointId: `ckpt-${checkpoint.commit.slice(0, 12)}` as never, commit: checkpoint.commit, ref: checkpoint.ref },
              runId: effect.runId as never,
              turnId: effect.intent.turnId,
              type: "checkpoint.captured" as const,
            },
          },
        }];
      },
      recover: async (effect, context) => {
        if (context.signal.aborted) return [];
        return reactors.build()["checkpoint.capture"]!.execute(effect, context);
      },
    });

    this.runtime = LocalHarnessRuntime.open(dbPath, {
      maxConcurrentRuns: resolveMaxConcurrentRuns(Bun.env as Record<string, string | undefined>),
      reactors: reactors.build(),
      workflowChildExecutor: async ({ effect, task, context }) => {
        const deps = this.config.adapterDeps;
        if (!deps?.resolveProjectRoot) throw new Error("workflow child execution requires resolveProjectRoot adapter dep");
        if (context.signal.aborted) throw new Error("workflow child execution was cancelled");
        const capabilities: Capability[] = task.capabilities?.filter(
          (capability): capability is Capability => ["read", "edit", "exec", "task"].includes(capability),
        ) as Capability[] ?? (task.capabilityCeiling === "read-only"
          ? ["read", "task"]
          : ["read", "edit", "exec", "task"]);
        const subagentDeps = {
          provider: this.provider,
          platform: deps.platform ?? "linux",
          resolveProjectRoot: deps.resolveProjectRoot,
        };
        const workflowKind = effect.intent.kind === "workflow.create_child"
          ? effect.intent.workflowKind
          : "subagent";
        const reviewTurnId = task.turnId ?? task.threadId ?? (effect.runId as string);
        const reviewerInputs = workflowKind === "review-jury"
          ? [
              { roleName: "reviewer", modelId: task.modelId ?? DEFAULT_MODEL_ID },
              { roleName: "reviewer-security", modelId: task.securityModelId ?? "openai/gpt-5-mini" },
            ]
          : [{ roleName: task.roleName ?? task.role, modelId: task.modelId }];
        const reviewerEvents = await Promise.all(reviewerInputs.map((reviewer, index) => executeSubagent(
          {
            task: workflowKind === "review-jury"
              ? `${task.objective}\n\nYou are the ${reviewer.roleName} member of a two-reviewer jury.\n${REVIEW_JURY_FINDINGS_FORMAT}`
              : task.objective,
            roleName: reviewer.roleName,
            capabilities,
            projectPath: task.projectPath ?? this.projectPathByRun.get(effect.runId as string) ?? ".",
            threadId: task.threadId ?? (effect.runId as string),
            modelId: reviewer.modelId,
          },
          subagentDeps,
          `workflow-${effect.effectId}-${index + 1}`,
        )));
        const normalizedEvents = reviewerEvents.flatMap((reviewerEventsForRole) => canonicalizeSubagentEvents(
          reviewerEventsForRole,
          effect.runId as string,
          reviewTurnId,
        ));
        const terminalEvents = reviewerEvents.flatMap((reviewerEventsForRole) => reviewerEventsForRole);
        const terminal = [...terminalEvents].reverse().find((event) => event.type === "activity.completed" || event.type === "activity.failed");
        const terminalPayload = terminal?.payload ?? {};
        const allReviewersSucceeded = reviewerEvents.every((reviewerEventsForRole) =>
          [...reviewerEventsForRole].reverse().some((event) => event.type === "activity.completed"),
        );
        const findings = workflowKind === "review-jury"
          ? mergeJuryFindings(reviewerEvents.flatMap((reviewerEventsForRole, index) => {
              const completed = [...reviewerEventsForRole].reverse().find((event) => event.type === "activity.completed");
              return parseJuryFindings(String(completed?.payload.summary ?? ""), reviewerInputs[index]!.roleName);
            }))
          : [];
        const reviewEvents = findings.map((finding, index) => {
          const comment = juryFindingToReviewComment(finding, index);
          return {
            causationId: effect.effectId as never,
            correlationId: `corr-jury-${effect.runId}` as never,
            eventId: `${comment.commentId}-${effect.effectId}` as never,
            payload: comment,
            runId: effect.runId as never,
            turnId: reviewTurnId as never,
            type: "review.comment.created" as const,
          };
        });
        return {
          commands: [...normalizedEvents, ...reviewEvents].map((normalizedEvent) => ({
            type: "provider.event" as const,
            payload: {
              providerInstanceId: "provider-local" as never,
              normalizedEvent,
            },
          })),
          result: {
            artifacts: [],
            findings: findings.map((finding) => `${finding.severity}: ${finding.title}`),
            status: allReviewersSucceeded && terminal?.type === "activity.completed" ? "success" : "failed",
            summary: String(terminalPayload.summary ?? terminalPayload.error ?? "Subagent completed"),
          },
        };
      },
    });

    // 3. Create Convex adapters (or use test-injected fakes)
    this.commandGateway = this.config.commandGateway ?? createConvexCommandSource({
      deploymentUrl: this.config.deploymentUrl,
      deviceToken: this.config.deviceToken,
    });
    this.projectionSink = this.config.projectionSink ?? createConvexProjectionSink({
      deploymentUrl: this.config.deploymentUrl,
      deviceToken: this.config.deviceToken,
    });

    // 4. Operational wiring
    this.supervisor = new DaemonSupervisor({
      maxRestarts: 3,
      restartWindowMs: 60_000,
      shutdownTimeoutMs: 5_000,
    });
    this.supervisor.started();

    // Log threat model boundaries
    console.info("Relay threat model loaded:", THREAT_MODEL.map((b: { name: string }) => b.name).join(", "));

    // Check version compatibility
    const currentVersion = parseVersion("1.0.0");
    console.info("Kernel daemon version check:", {
      current: currentVersion,
      compatible: isCompatibleUpgrade(currentVersion, currentVersion),
    });

    console.info(
      `Relay kernel daemon starting as ${this.config.machineName} (mode: kernel)`,
    );

    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, this.config.heartbeatIntervalMs);

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.config.pollIntervalMs ?? 1_000);
    this.startupSpan = startSpan;

    process.once("SIGINT", () => void this.shutdownAndExit());
    process.once("SIGTERM", () => void this.shutdownAndExit());

    this.tracer.endSpan(startSpan);
  }

  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private flushInFlight: Promise<void> | null = null;
  private startupSpan?: TraceSpan;

  /**
   * Graceful shutdown without terminating the process — safe for tests and
   * for a supervisor-driven restart. Clears timers, drains the codex
   * adapter, flushes projections, and closes the local store.
   */
  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    try {
      this.codexAdapter?.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Transport closed")) throw error;
    }
    await this.flush();
    await this.runtime.shutdown();
    if (this.startupSpan) this.tracer.endSpan(this.startupSpan);
    const spans = this.tracer.getSpans();
    console.info(`Kernel daemon shutting down. ${spans.length} traces recorded.`);
  }

  /** SIGINT/SIGTERM handler — graceful stop, then terminate the process. */
  private async shutdownAndExit(): Promise<void> {
    await this.stop();
    process.exit(0);
  }

  /** Run one poll/claim/dispatch cycle immediately — for tests and manual triggers. */
  async pollOnce(): Promise<void> {
    await this.poll();
  }

  /** Run one canary heartbeat immediately — for tests and supervised probes. */
  async heartbeatOnce(): Promise<void> {
    await this.heartbeat();
  }

  /** Publish the projection outbox and run snapshots immediately — for tests and manual triggers. */
  async flushOnce(): Promise<void> {
    await this.flush();
  }

  private pollInFlight = false;

  // Command lease lifetime — long enough to cover a normal turn between
  // polls, short enough that a crashed worker's claim is reclaimable
  // quickly. Renewal (see processCommand) keeps genuinely long-running
  // effects alive well past this window. Overridable for kill-point tests.
  private get commandLeaseDurationMs(): number {
    return this.config.commandLeaseDurationMs ?? 30_000;
  }

  private async poll(): Promise<void> {
    if (this.shuttingDown || this.pollInFlight) return;
    this.pollInFlight = true;
    const span = this.tracer.startSpan("daemon.poll");
    try {
      const admission = await this.storageAdmission();
      if (!admission.allowMutation) {
        console.warn("Kernel daemon: mutation admission paused", admission.reason);
        return;
      }
      const batch = await this.commandGateway.claimBatch({
        deviceToken: this.config.deviceToken,
        leaseDurationMs: this.commandLeaseDurationMs,
        limit: 5,
      });

      incrementMetric("eventsProcessed");

      for (const cmd of batch) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(cmd.payloadJson ?? "{}") as Record<string, unknown>;
        } catch {
          await this.commandGateway.completeCommand({
            commandId: cmd.commandId,
            deviceToken: this.config.deviceToken,
            leaseGeneration: cmd.leaseGeneration,
            status: "rejected",
          });
          continue;
        }

        await this.processCommand(cmd.commandId, cmd.externalCommandId, cmd.kind, payload, cmd.runId, cmd.leaseGeneration, cmd.projectPath);
      }
    } catch (error) {
      if (!this.shuttingDown) {
        if (isDeviceTokenRejected(error)) this.canaryTelemetry.authFailures++;
        console.error("Kernel daemon: poll failed", error);
      }
    }
    this.pollInFlight = false;
    this.tracer.endSpan(span);
  }

  private async storageAdmission(): Promise<{ allowMutation: boolean; reason?: string }> {
    try {
      const filesystem = await statfs(this.config.daemonHome);
      const blockSize = Number(filesystem.bsize);
      return storageAdmission({
        freeBytes: Number(filesystem.bavail) * blockSize,
        totalBytes: Number(filesystem.blocks) * blockSize,
        activeRecoveryBytes: 64 * 1024 * 1024,
      });
    } catch (error) {
      this.canaryTelemetry.unrecoverableFailures++;
      return { allowMutation: false, reason: `storage_probe_failed:${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async processCommand(
    commandId: string,
    externalCommandId: string,
    kind: string,
    payload: Record<string, unknown>,
    runId?: string,
    leaseGeneration?: number,
    projectPath?: string,
  ): Promise<void> {
    const span = this.tracer.startSpan(`command.${kind}`);
    span.tags["commandId"] = commandId;
    if (projectPath && runId) this.projectPathByRun.set(runId, projectPath);

    // Renew the exact lease generation for the full external-effect
    // lifetime — a claim's initial lease only covers the gap between polls,
    // not a genuinely long-running provider turn. Renewal failure means the
    // lease was lost (expired and reclaimed, or taken by another worker):
    // fence completion so a stale worker never commits a result another
    // owner may already be producing.
    let leaseLost = false;
    this.canaryTelemetry.activeLeases++;
    const stopRenewal = leaseGeneration === undefined ? undefined : startLeaseRenewal({
      commandGateway: this.commandGateway,
      commandId,
      deviceToken: this.config.deviceToken,
      leaseGeneration,
      leaseDurationMs: this.commandLeaseDurationMs,
      onLost: (error) => {
        leaseLost = true;
        console.error(
          "Kernel daemon: lease renewal failed — fencing completion",
          commandId,
          error instanceof Error ? error.message : error,
        );
      },
    });

    const complete = async (status: "completed" | "rejected") => {
      if (leaseLost) {
        this.canaryTelemetry.recoverableFailures++;
        console.error("Kernel daemon: skipping completion — lease was lost mid-execution", commandId);
        return;
      }
      try {
        await this.commandGateway.completeCommand({
          commandId,
          deviceToken: this.config.deviceToken,
          leaseGeneration: leaseGeneration ?? 0,
          status,
        });
      } catch (error) {
        // The completion report itself failed (lost response, network
        // partition) — the command's local work already ran. Do not
        // compound this with a second completion attempt, which could
        // silently overwrite a real success with "rejected". Leave the
        // command claimed; it becomes reclaimable after lease expiry and
        // is safely redelivered (engine-level operations are idempotent).
        const message = error instanceof Error ? error.message : String(error);
        if (/duplicate|already complete|already completed/i.test(message)) this.canaryTelemetry.duplicateCommands++;
        console.error(
          "Kernel daemon: completion report failed — command remains claimed for redelivery",
          commandId,
          status,
          message,
        );
      }
    };

    try {
      switch (kind) {
        case "run.create": {
          const projectId = (payload.projectId ?? "default") as string;
          const mode = payload.mode === undefined ? undefined : payload.mode === "chat" || payload.mode === "plan" ? payload.mode : (() => { throw new Error("mode is invalid"); })();
          const title = payload.title === undefined ? undefined : requireBoundedString(payload.title, "title", 200);
          const permissionProfile = payload.permissionProfile === undefined ? undefined : payload.permissionProfile === "read-only" || payload.permissionProfile === "workspace-write" || payload.permissionProfile === "full-access" ? payload.permissionProfile : (() => { throw new Error("permissionProfile is invalid"); })();
          if (typeof payload.projectPath === "string" && payload.projectPath.length > 0 && runId) {
            this.projectPathByRun.set(runId, payload.projectPath);
          }
          // `runId` is the canonical ID assigned at command ingress
          // (submitToInbox defaults it to the thread ID). The local run
          // must be created under this exact ID — otherwise the
          // client-visible run identity a browser/projection reader knows
          // about can never be found by a later run.resume/turn.send that
          // references the same canonical ID.
          await this.runtime.createRun({ mode, permissionProfile, projectId, runId: runId as never, title });
          if (mode === "plan") {
            const initialPlan = await appendAdapterEvent(this.runtime, runId as string, planEvent({
              buildModelId: DEFAULT_MODEL_ID,
              phase: "planning",
              planModelId: DEFAULT_MODEL_ID,
              runId: runId as string,
            }, "local"));
            if (!initialPlan.ok) throw new Error(`Failed to initialize plan state: ${initialPlan.reason}`);
          }
          if (this.config.adapterDeps?.resolveSlashCommands && projectPath) {
            const slashCommands = (await this.config.adapterDeps.resolveSlashCommands({ projectPath })).slice(0, 200).map((entry) => ({
              ...(entry.argumentHint ? { argumentHint: entry.argumentHint.slice(0, 200) } : {}),
              description: entry.description.slice(0, 2_000),
              name: entry.name.slice(0, 200),
              ...(entry.projectPath ? { projectPath: entry.projectPath.slice(0, 2_000) } : {}),
              scope: entry.scope,
            }));
            const catalog = await appendAdapterEvent(this.runtime, runId as string, {
              eventId: `ev-run-slash-catalog-${externalCommandId}`,
              type: "run.configuration.updated",
              payload: { slashCommands },
            });
            if (!catalog.ok) throw new Error(`Failed to append slash-command catalog: ${catalog.reason}`);
          }
          incrementMetric("activeRuns");
          await complete("completed");
          break;
        }
        case "run.configure": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("run.configure requires runId");
          const configuration: Record<string, unknown> = {};
          if (payload.modelId !== undefined) configuration.modelId = requireBoundedString(payload.modelId, "modelId", 200);
          if (payload.thinkingLevel !== undefined) {
            if (payload.thinkingLevel !== "none" && payload.thinkingLevel !== "low" && payload.thinkingLevel !== "medium" && payload.thinkingLevel !== "high") throw new Error("thinkingLevel is invalid");
            configuration.thinkingLevel = payload.thinkingLevel;
          }
          if (payload.permissionProfile !== undefined) {
            if (payload.permissionProfile !== "read-only" && payload.permissionProfile !== "workspace-write" && payload.permissionProfile !== "full-access") throw new Error("permissionProfile is invalid");
            configuration.permissionProfile = payload.permissionProfile;
          }
          if (payload.budgetUsd !== undefined) {
            if (payload.budgetUsd !== null && (typeof payload.budgetUsd !== "number" || !Number.isFinite(payload.budgetUsd) || payload.budgetUsd < 0)) throw new Error("budgetUsd is invalid");
            configuration.budgetUsd = payload.budgetUsd;
          }
          const planModelId = payload.planModelId === undefined ? undefined : requireBoundedString(payload.planModelId, "planModelId", 200);
          const buildModelId = payload.buildModelId === undefined ? undefined : requireBoundedString(payload.buildModelId, "buildModelId", 200);
          if (planModelId !== undefined || buildModelId !== undefined) {
            const snapshot = await this.runtime.snapshot({ runId: rId as never });
            if (snapshot.mode !== "plan" || snapshot.planPhase !== "planning" || snapshot.plan) throw new Error("Plan models can only change before planning starts");
            const result = await appendAdapterEvent(this.runtime, rId, planEvent({
              buildModelId: buildModelId ?? snapshot.buildModelId ?? DEFAULT_MODEL_ID,
              phase: "planning",
              planModelId: planModelId ?? snapshot.planModelId ?? DEFAULT_MODEL_ID,
              runId: rId,
            }, "local"));
            if (!result.ok) throw new Error(`Failed to append plan configuration: ${result.reason}`);
          }
          if (Object.keys(configuration).length > 0) {
            const result = await appendAdapterEvent(this.runtime, rId, {
              eventId: `ev-run-configuration-${externalCommandId}`,
              type: "run.configuration.updated",
              payload: configuration,
            });
            if (!result.ok) throw new Error(`Failed to append run configuration: ${result.reason}`);
          }
          if (Object.keys(configuration).length === 0 && planModelId === undefined && buildModelId === undefined) throw new Error("run.configure requires a configuration field");
          await complete("completed");
          break;
        }
        case "plan.update": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("plan.update requires runId");
          const snapshot = await this.runtime.snapshot({ runId: rId as never });
          if (snapshot.mode !== "plan" || snapshot.planPhase !== "review" || !snapshot.plan) throw new Error("Plan is not editable");
          const expectedRevision = requireNonNegativeInteger(payload.expectedRevision, "expectedRevision");
          if (expectedRevision !== snapshot.plan.revision) throw new Error("Plan revision is stale");
          const content = requireBoundedString(payload.content, "content", 100_000);
          const result = await appendAdapterEvent(this.runtime, rId, planEvent({
            content,
            phase: "review",
            revision: expectedRevision + 1,
            runId: rId,
            status: "draft",
          }, "local"));
          if (!result.ok) throw new Error(`Failed to update plan: ${result.reason}`);
          await complete("completed");
          break;
        }
        case "plan.approve": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("plan.approve requires runId");
          const snapshot = await this.runtime.snapshot({ runId: rId as never });
          if (snapshot.mode !== "plan" || snapshot.planPhase !== "review" || !snapshot.plan) throw new Error("Plan is not awaiting approval");
          const expectedRevision = requireNonNegativeInteger(payload.expectedRevision, "expectedRevision");
          if (expectedRevision !== snapshot.plan.revision) throw new Error("Plan revision is stale");
          const content = requireBoundedString(payload.content, "content", 100_000);
          const updated = await appendAdapterEvent(this.runtime, rId, planEvent({
            buildModelId: snapshot.buildModelId,
            content,
            phase: "building",
            planModelId: snapshot.planModelId,
            revision: expectedRevision + 1,
            runId: rId,
            status: "approved",
          }, "local"));
          if (!updated.ok) throw new Error(`Failed to approve plan: ${updated.reason}`);
          await this.runtime.sendTurn({
            commandId: externalCommandId as never,
            prompt: `Execute the approved plan:\n\n${content}`,
            runId: rId as never,
          });
          void this.runtime.drainEffects().catch((error) => console.error("Kernel daemon: plan build effect drain failed", rId, error));
          await complete("completed");
          break;
        }
        case "run.resume": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("run.resume requires runId");
          await this.runtime.resumeRun({ runId: rId as never });
          await complete("completed");
          break;
        }
        case "run.stop": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("run.stop requires runId");
          await this.runtime.stopRun({ runId: rId as never });
          this.projectPathByRun.delete(rId);
          incrementMetric("completedRuns");
          await complete("completed");
          break;
        }
        case "turn.steer": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("turn.steer requires runId");
          const steering = (payload.steering ?? "") as string;
          await this.runtime.steerTurn({ runId: rId as never, steering });
          void this.runtime.drainControlEffects().catch((error) => console.error("Kernel daemon: steer effect drain failed", error));
          await complete("completed");
          break;
        }
        case "turn.interrupt": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("turn.interrupt requires runId");
          const reason = payload.reason as string | undefined;
          await this.runtime.interruptTurn({ runId: rId as never, reason });
          void this.runtime.drainControlEffects().catch((error) => console.error("Kernel daemon: interrupt effect drain failed", error));
          await complete("completed");
          break;
        }
        case "approval.resolve": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("approval.resolve requires runId");
          const approvalId = (payload.approvalId ?? "") as string;
          const resolution = (payload.resolution === "deny" ? "deny" : "allow") as "allow" | "deny";
          await this.runtime.resolveApproval({ runId: rId as never, approvalId, resolution });
          await complete("completed");
          break;
        }
        case "mcp.elicitation.resolve": {
          const elicitationId = requireBoundedString(payload.elicitationId, "elicitationId", 200);
          const responseJson = requireBoundedString(payload.responseJson, "responseJson", 100_000);
          const resolveInput = this.config.adapterDeps?.mcp?.resolveMcpInput;
          if (!resolveInput) throw new Error("mcp.elicitation.resolve requires the MCP adapter");
          await resolveInput({ elicitationId, responseJson });
          await complete("completed");
          break;
        }
        case "mcp.elicitation.cancel": {
          const elicitationId = requireBoundedString(payload.elicitationId, "elicitationId", 200);
          const cancelInput = this.config.adapterDeps?.mcp?.cancelMcpInput;
          if (!cancelInput) throw new Error("mcp.elicitation.cancel requires the MCP adapter");
          await cancelInput(elicitationId);
          await complete("completed");
          break;
        }
        case "review.comment.create": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("review.comment.create requires runId");
          const comment = normalizeReviewComment(payload);
          const result = await appendAdapterEvent(this.runtime, rId, {
            eventId: `ev-review-comment-created-${externalCommandId}`,
            type: "review.comment.created",
            payload: comment,
          });
          if (!result.ok) throw new Error(`Failed to append review comment: ${result.reason}`);
          await complete("completed");
          break;
        }
        case "turn.send": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("turn.send requires runId");
          const rawPrompt = (payload.prompt ?? "Hello") as string;
          if (typeof payload.projectPath === "string" && payload.projectPath.length > 0) {
            this.projectPathByRun.set(rId, payload.projectPath);
          }

          const reviewComments = normalizeReviewComments(payload.reviewComments);
          const reviewCommentIds = normalizeStringArray(
            payload.reviewCommentIds ?? reviewComments.map((comment) => comment.commentId),
            "reviewCommentIds",
          );
          const receivedCommentIds = new Set(reviewComments.map((comment) => comment.commentId));
          if (reviewCommentIds.some((commentId) => !receivedCommentIds.has(commentId))) {
            throw new Error("reviewCommentIds must refer only to comments included in reviewComments");
          }

          // Security: scan the complete provider prompt, including review feedback,
          // for secrets before sending it to the provider.
          const providerPrompt = buildTurnPrompt({ content: rawPrompt, reviewComments: reviewComments as ReviewComment[] });
          const secretFindings = scanForSecrets(providerPrompt);
          if (secretFindings.length > 0) {
            console.warn("Kernel daemon: secrets detected in prompt:", secretFindings);
            throw new Error("Prompt contains credentials — rejected by security scan");
          }
          // Sanitize prompt before logging/projection
          const prompt = sanitizeForProjection(rawPrompt);

          const turnStart = Date.now();

          // Route through the durable reactor instead of direct execution.
          // sendTurn creates the effect; drainEffects invokes the registered
          // provider reactor which executes the turn and streams events back.
          await this.runtime.sendTurn({
            runId: rId as never,
            prompt,
            commandId: externalCommandId as never,
            ...(reviewComments.length > 0 ? { reviewComments } : {}),
            ...(reviewCommentIds.length > 0 ? { reviewCommentIds } : {}),
          });

          // The durable effect is now queued. Do not hold the command poller
          // hostage to provider latency: later steer/interrupt commands must
          // be claimable while this effect is streaming.
          void this.runtime.drainEffects().catch((error) => {
            console.error("Kernel daemon: turn effect drain failed", rId, error);
          });
          span.tags["turnLatencyMs"] = String(Date.now() - turnStart);
          span.tags["turnSucceeded"] = "queued";
          await complete("completed");
          break;
        }
        case "git.action": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("git.action requires runId");
          if (!this.config.adapterDeps?.resolveProjectRoot) throw new Error("git.action requires resolveProjectRoot adapter dep");
          const action = payload.action;
          if (action !== "stage" && action !== "commit" && action !== "push") throw new Error("git.action requires a supported action");
          const actionMessage = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : undefined;
          const root = await this.config.adapterDeps.resolveProjectRoot({
            repoPath: (typeof payload.projectPath === "string" ? payload.projectPath : projectPath ?? this.projectPathByRun.get(rId)) ?? ".",
            threadId: rId,
          });
          const actionId = externalCommandId;
          const appendGitEvent = (status: "running" | "complete" | "failed", details: { commit?: string; error?: string } = {}) => appendAdapterEvent(this.runtime, rId, {
            eventId: `ev-git-action-${actionId}-${status}`,
            type: "git.action.updated",
            payload: { action, actionId, status, ...(actionMessage ? { message: sanitizeForProjection(actionMessage) } : {}), ...details },
          });
          const started = await appendGitEvent("running");
          if (!started.ok) throw new Error(`Failed to append Git action start: ${started.reason}`);
          try {
            let commit: string | undefined;
            if (action === "stage") await stageAll({ root });
            if (action === "commit") commit = await commitChanges({ message: actionMessage ?? "Relay changes", root });
            if (action === "push") await pushChanges({ root });
            const completed = await appendGitEvent("complete", commit ? { commit } : {});
            if (!completed.ok) throw new Error(`Failed to append Git action completion: ${completed.reason}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const failed = await appendGitEvent("failed", { error: sanitizeForProjection(message) });
            if (!failed.ok) console.error("Kernel daemon: failed to append Git action failure", failed.reason);
            throw error;
          }
          await complete("completed");
          break;
        }
        case "checkpoint.restore": {
          if (!this.config.adapterDeps?.resolveProjectRoot) {
            throw new Error("checkpoint.restore requires resolveProjectRoot adapter dep");
          }
          const ckptEvents = await executeCheckpointRestore(
            {
              commit: (payload.commit ?? "HEAD") as string,
              projectPath: (payload.projectPath ?? projectPath ?? this.projectPathByRun.get(runId ?? "") ?? ".") as string,
              threadId: (payload.threadId ?? runId ?? "") as string,
            },
            {
              resolveProjectRoot: this.config.adapterDeps.resolveProjectRoot,
            },
            runId ?? `ckpt-${commandId}`,
          );
          for (const ev of ckptEvents) {
            await appendAdapterEvent(this.runtime, runId ?? `ckpt-${commandId}`, {
              eventId: ev.eventId,
              type: ev.type as "checkpoint.restored" | "workspace.diff.updated",
              payload: ev.payload,
            });
          }
          await complete("completed");
          break;
        }
        case "checkpoint.compare": {
          if (!this.config.adapterDeps?.resolveProjectRoot) {
            throw new Error("checkpoint.compare requires resolveProjectRoot adapter dep");
          }
          const cmpEvents = await executeCheckpointComparison(
            {
              fromCommit: (payload.fromCommit ?? "HEAD~1") as string,
              fromCheckpointId: (payload.fromCheckpointId ?? payload.fromCommit ?? "from") as string,
              toCommit: (payload.toCommit ?? "HEAD") as string,
              toCheckpointId: (payload.toCheckpointId ?? payload.toCommit ?? "to") as string,
              projectPath: (payload.projectPath ?? projectPath ?? this.projectPathByRun.get(runId ?? "") ?? ".") as string,
              threadId: (payload.threadId ?? runId ?? "") as string,
            },
            {
              resolveProjectRoot: this.config.adapterDeps.resolveProjectRoot,
            },
            runId ?? `cmp-${commandId}`,
          );
          for (const ev of cmpEvents) {
            await appendAdapterEvent(this.runtime, runId ?? `cmp-${commandId}`, {
              eventId: ev.eventId,
              type: ev.type as "checkpoint.compared",
              payload: ev.payload,
            });
          }
          await complete("completed");
          break;
        }
        case "subagent.run": {
          if (!runId) throw new Error("subagent.run requires a parent runId");
          const taskId = (payload.taskId ?? `subagent-${commandId}`) as string;
          await this.runtime.runWorkflow({
            runId,
            workflowKind: typeof payload.workflowKind === "string" ? payload.workflowKind : "subagent",
            task: {
              taskId: taskId as never,
              runId: runId as never,
              role: "builder",
              roleName: (payload.roleName ?? "worker") as string,
              objective: (payload.task ?? "") as string,
              dependencies: [],
              capabilityCeiling: (payload.capabilityCeiling ?? "workspace-write") as string,
              capabilities: (payload.capabilities ?? []) as Capability[],
              contextBudget: 8_000,
              workspaceMode: "isolated-worktree",
              state: "ready",
              attempt: 0,
              maxAttempts: 3,
              projectPath: (payload.projectPath ?? projectPath ?? ".") as string,
              threadId: (payload.threadId ?? runId) as string,
              turnId: payload.turnId as string | undefined,
              modelId: payload.modelId as string | undefined,
              securityModelId: payload.securityModelId as string | undefined,
            },
          });
          await complete("completed");
          break;
        }
        default: {
          console.warn("Kernel daemon: unknown command kind — rejecting", kind);
          await complete("rejected");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Kernel daemon: command failed", commandId, kind, message);
      if (isDeviceTokenRejected(error)) this.canaryTelemetry.authFailures++;
      if (/sandbox violation/i.test(message)) this.canaryTelemetry.sandboxViolations++;
      if (!/requires |is invalid|not allowed|not awaiting|not editable|stale|already running|already completed/i.test(message)) this.canaryTelemetry.unrecoverableFailures++;
      await complete("rejected");
    } finally {
      stopRenewal?.();
      this.canaryTelemetry.activeLeases--;
    }

    this.tracer.endSpan(span);
  }

  private async flush(): Promise<void> {
    // Heartbeat-driven flushes and explicit test/control flushes can overlap.
    // Serialize them so a second publisher cannot claim later outbox rows
    // while an earlier batch for the same run is still in flight; Convex
    // correctly rejects that as a projection gap.
    if (this.flushInFlight) {
      await this.flushInFlight;
      return;
    }

    const operation = (async () => {
      await flushProjections({
        deviceToken: this.config.deviceToken,
        runtime: this.runtime,
        projectionSink: this.projectionSink,
        machineId: this.config.machineId,
        telemetry: this.projectionTelemetry,
      });
      this.canaryTelemetry.projectionBacklog = this.projectionTelemetry.backlog;
      this.canaryTelemetry.pendingEffects = this.projectionTelemetry.backlog;
      this.canaryTelemetry.projectionGaps = this.projectionTelemetry.conflicts;
      this.canaryTelemetry.projectionDivergences = this.projectionTelemetry.conflicts;
    })();
    this.flushInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.flushInFlight === operation) this.flushInFlight = null;
    }
  }

  private heartbeatCount = 0;
  private async heartbeat(): Promise<void> {
    if (this.shuttingDown) return;
    try {
      this.heartbeatCount++;
      if (this.heartbeatCount % 10 === 0) {
        await this.flush();
      }
      const telemetry = this.canarySnapshot();
      await this.config.onCanaryTelemetry?.(telemetry);
      const rollbackReason = canaryRollbackReason(telemetry, this.config.rollbackThresholds ?? DEFAULT_ROLLBACK_THRESHOLDS);
      if (rollbackReason) await this.triggerCanaryRollback(rollbackReason, telemetry);
      // Log health/metrics every 60 heartbeats (~30s at default 500ms interval)
      if (this.heartbeatCount % 60 === 0) {
        const retention = this.runtime.maintain();
        const metrics = getMetrics();
        const health = getHealth();
        console.info("Kernel daemon health:", {
          ok: health.ok,
          sqlite: health.sqlite,
          activeRuns: metrics.activeRuns,
          completedRuns: metrics.completedRuns,
          eventsProcessed: metrics.eventsProcessed,
          uptimeMinutes: Math.round(metrics.uptimeMs / 60000),
        });
        console.info("Kernel daemon projection outbox:", this.projectionTelemetry);
        console.info("Kernel daemon local-store maintenance:", {
          pressure: retention.pressure,
          databaseBytes: retention.after.databaseBytes,
          deletedEvents: retention.deletedEvents,
          deletedCheckpoints: retention.deletedCheckpoints,
        });
        // SLO tracking: log prompt-to-first-token stats
        if (this.firstTokenLatencies.length > 0) {
          const sorted = [...this.firstTokenLatencies].sort((a, b) => a - b);
          const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
          const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
          console.info("Kernel daemon SLO (prompt-to-first-token ms):", {
            count: this.firstTokenLatencies.length,
            p50,
            p95,
            target: SLO_DEFINITIONS.find(
              (s: { name: string; target: number }) => s.name === "prompt-to-first-token-latency",
            )?.target,
          });
          // Keep a rolling window
          if (this.firstTokenLatencies.length > 500) {
            this.firstTokenLatencies = this.firstTokenLatencies.slice(-250);
          }
        }
      }
    } catch (error) {
      if (isDeviceTokenRejected(error)) {
        this.canaryTelemetry.authFailures++;
        console.error("Kernel daemon: device token rejected; shutting down.");
        this.shuttingDown = true;
        process.exit(1);
      }
      console.error("Kernel daemon: heartbeat failed", error);
    }
  }

  private canarySnapshot(): CanaryTelemetry {
    const fallbackActivations = this.provider?.fallbackActivations ?? this.canaryTelemetry.fallbackActivations;
    this.canaryTelemetry.fallbackActivations = fallbackActivations;
    return { mode: "kernel", ...this.canaryTelemetry };
  }

  private async triggerCanaryRollback(reason: string, telemetry: CanaryTelemetry): Promise<void> {
    if (this.canaryRollbackTriggered || this.shuttingDown) return;
    this.canaryRollbackTriggered = true;
    const markerPath = join(this.config.daemonHome, "kernel-canary-rollback.json");
    try {
      await mkdir(this.config.daemonHome, { recursive: true });
      await writeFile(markerPath, `${JSON.stringify({ reason, telemetry, recordedAt: Date.now() })}\n`, { mode: 0o600 });
    } catch (error) {
      console.error("Kernel daemon: failed to persist canary rollback marker", error instanceof Error ? error.message : error);
    }
    console.error("Kernel daemon: canary invariant violated; stopping kernel for legacy rollback", { markerPath, reason, telemetry });
    await this.stop();
    await this.config.onCanaryRollback?.({ reason, telemetry });
  }
}

function activeTurnKey(runId: string, turnId: string): string {
  return `${runId}\u0000${turnId}`;
}

function safeMcpTaskId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

function kernelPlanPrompt(input: { phase?: PlanPhase; approvedContent?: string }): string {
  if (input.phase === "planning") {
    return "PLAN MODE — PLANNING PHASE: investigate the request with read-only tools, then return an ordered, verifiable implementation plan. Do not modify files, run mutating commands, delegate subagents, or call mutating MCP tools.";
  }
  if (input.phase === "building") {
    return `PLAN MODE — BUILDING PHASE: execute the approved plan below step by step and verify each step.\n\nAPPROVED PLAN:\n${(input.approvedContent ?? "").slice(0, 100_000)}`;
  }
  return "";
}

function assistantTextFromEvents(events: ReadonlyArray<CanonicalEventDraft>): string {
  return events
    .filter((event) => event.type === "assistant.delta")
    .map((event) => {
      const text = event.payload && typeof event.payload === "object" ? (event.payload as { text?: unknown }).text : undefined;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function planEvent(input: {
  buildModelId?: string;
  content?: string;
  phase: PlanPhase;
  planModelId?: string;
  revision?: number;
  runId: string;
  status?: "draft" | "approved";
  turnId?: string;
}, source: "codex" | "local"): CanonicalEventDraft {
  const suffix = input.turnId ?? "configuration";
  return {
    causationId: `plan-${source}-${input.runId}-${suffix}` as never,
    correlationId: `corr-plan-${input.runId}` as never,
    eventId: `ev-plan-${source}-${input.runId}-${suffix}-${input.phase}` as never,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId as never }),
    type: "plan.updated",
    payload: {
      ...(input.buildModelId === undefined ? {} : { buildModelId: input.buildModelId }),
      ...(input.content === undefined ? {} : { content: input.content }),
      phase: input.phase,
      ...(input.planModelId === undefined ? {} : { planModelId: input.planModelId }),
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      ...(input.status === undefined ? {} : { status: input.status }),
    },
  } as CanonicalEventDraft;
}

function linkAbortSignals(primary: AbortSignal, secondary: AbortSignal): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => controller.abort(signal.reason);
  if (primary.aborted) abort(primary);
  if (secondary.aborted) abort(secondary);
  const primaryListener = () => abort(primary);
  const secondaryListener = () => abort(secondary);
  primary.addEventListener("abort", primaryListener, { once: true });
  secondary.addEventListener("abort", secondaryListener, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener("abort", primaryListener);
      secondary.removeEventListener("abort", secondaryListener);
    },
  };
}

function unavailableGovernance(): GovernanceGateway {
  return {
    recordDecision: async () => undefined,
    requestApproval: async () => "deny",
  };
}

function normalizeReviewComment(value: Record<string, unknown>): ReviewCommentInput {
  const comments = normalizeReviewComments([value]);
  const comment = comments[0];
  if (!comment) throw new Error("review.comment.create requires a comment payload");
  return comment;
}

function normalizeReviewComments(value: unknown): ReviewCommentInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error("reviewComments must be an array of at most 100 comments");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`reviewComments[${index}] must be an object`);
    const record = entry as Record<string, unknown>;
    const commentId = requireBoundedString(record.commentId, `reviewComments[${index}].commentId`, 200);
    const content = requireBoundedString(record.content, `reviewComments[${index}].content`, 20_000);
    const filePath = requireBoundedString(record.filePath, `reviewComments[${index}].filePath`, 2_000);
    const startLine = requirePositiveInteger(record.startLine, `reviewComments[${index}].startLine`);
    const endLine = requirePositiveInteger(record.endLine, `reviewComments[${index}].endLine`);
    if (endLine < startLine) throw new Error(`reviewComments[${index}].endLine must be >= startLine`);
    return { commentId, content, endLine, filePath, startLine };
  });
}

function normalizeStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be an array of at most 100 strings`);
  const values = value.map((entry, index) => requireBoundedString(entry, `${label}[${index}]`, 200));
  return [...new Set(values)];
}

function requireBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function reviewCommentResolutionEvents(input: { commentIds: ReadonlyArray<string>; runId: string; turnId: string }): CanonicalEventDraft[] {
  return [...new Set(input.commentIds)].map((commentId, index) => {
    const safeCommentId = commentId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const eventId = `ev-review-comment-resolved-${input.runId}-${input.turnId}-${index}-${safeCommentId}`;
    return {
      causationId: `review-resolve-${input.runId}-${input.turnId}-${index}` as never,
      correlationId: `corr-review-${input.runId}-${input.turnId}` as never,
      eventId: eventId as never,
      payload: { commentId },
      runId: input.runId as never,
      turnId: input.turnId as never,
      type: "review.comment.resolved",
    } as CanonicalEventDraft;
  });
}

async function captureKernelCheckpoint(input: {
  readonly phase: "before" | "after";
  readonly root: string;
  readonly runId: string;
  readonly turnId: string;
}): Promise<CanonicalEventDraft> {
  const checkpoint = await createCheckpoint({
    root: input.root,
    threadId: input.runId,
    turnId: `${input.turnId}-${input.phase}`,
  });
  return {
    causationId: `checkpoint-${input.phase}-${input.runId}-${input.turnId}` as never,
    correlationId: `corr-checkpoint-${input.runId}-${input.turnId}` as never,
    eventId: `ev-checkpoint-${input.phase}-${input.runId}-${input.turnId}` as never,
    payload: {
      checkpointId: `ckpt-${checkpoint.commit.slice(0, 12)}` as never,
      commit: checkpoint.commit,
      ref: checkpoint.ref,
    },
    turnId: input.turnId as never,
    type: "checkpoint.captured",
  } as CanonicalEventDraft;
}

async function captureKernelDiff(input: {
  readonly root: string;
  readonly runId: string;
  readonly turnId: string;
}): Promise<CanonicalEventDraft> {
  const content = await computeDiff({ root: input.root, startCommit: "HEAD" });
  const boundedContent = content.length > 750_000 ? `${content.slice(0, 750_000)}\n[diff truncated]` : content;
  return {
    causationId: `diff-${input.runId}-${input.turnId}` as never,
    correlationId: `corr-diff-${input.runId}-${input.turnId}` as never,
    eventId: `ev-diff-${input.runId}-${input.turnId}` as never,
    payload: { baseCommit: "HEAD", content: boundedContent },
    turnId: input.turnId as never,
    type: "workspace.diff.updated",
  } as CanonicalEventDraft;
}
