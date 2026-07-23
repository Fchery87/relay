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

import { isDeviceTokenRejected } from "./device-auth";
import { createCodexSessionAdapter, type CodexSessionAdapter, type CodexTransportConfig, type NormalizedEvent } from "@relay/codex-app-server";
import {
  LocalHarnessRuntime,
  type AppendEventInput,
  type AppendEventResult,
} from "@relay/harness-runtime";
import { MutableReactorRegistry } from "@relay/orchestration";
import type { EffectIntent, EffectReactor } from "@relay/contracts";
import {
  canonicalEventPayloadError,
  canonicalEventRequiresTurn,
} from "@relay/contracts";
import type { CanonicalEventDraft, ReviewCommentInput } from "@relay/contracts";
import { DEFAULT_MODEL_ID, type Capability } from "@relay/shared";
import {
  createConvexCommandSource,
} from "./sync/convex-command-source";
import type { CommandGateway } from "./sync/convex-command-source";
import {
  createConvexProjectionSink,
} from "./sync/convex-projection-sink";
import type { ProjectionSink } from "./sync/convex-projection-sink";
import type { ModelProvider, ModelProviderRouter } from "./model-provider";
import type { GovernanceGateway } from "./governed-tool-executor";
import { executeGovernedToolCall, summarizeToolCall } from "./governed-tool-executor";
import type { Policy } from "./policy";
import { classifyToolCall, evaluatePolicy } from "./policy";
import type { MachinePlatform } from "@relay/shared";
import { ScriptedModelProvider } from "./model-provider";
import { LocalModelRouter } from "./catalog-provider-router";
import { persistProviderEvent } from "./provider-event-gateway";
import { resolveMaxConcurrentRuns } from "./runtime-mode";
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
import type { ToolCall } from "./tool-executor";
import {
  executeKernelAgenticTurn,
  resumeKernelAgenticTurn,
} from "./kernel-agentic-turn";
import { buildTurnPrompt, type ReviewComment } from "./agent-loop";
import { createCheckpoint } from "./checkpoints";
import { computeDiff } from "./git-review";

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
    governance?: GovernanceGateway;
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
  onBeforeTerminal?: (succeeded: boolean) => Promise<void>;
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
        if (terminalEvent && onBeforeTerminal) await onBeforeTerminal(ev.type === "turn.completed");
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

  // Canary telemetry — collected during command processing, reported via heartbeat.
  private canaryTelemetry = {
    activeLeases: 0,
    duplicateCommands: 0,
    pendingEffects: 0,
    projectionBacklog: 0,
    projectionGaps: 0,
    authFailures: 0,
    sandboxViolations: 0,
    recoverableFailures: 0,
    unrecoverableFailures: 0,
  };

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

  constructor(private readonly config: KernelDaemonConfig) {}

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
        if (codexEnabled && codex) {
          const snapshot = await this.runtime.snapshot({ runId });
          if (beforeCheckpoint) {
            const result = await persistProviderEvent(this.runtime, runId, {
              ...beforeCheckpoint,
            });
            if (!result.ok) throw new Error(`Failed to append Codex before checkpoint: ${result.reason}`);
          }
          await executeTurnViaCodex({
            codexAdapter: codex,
            prompt: providerPrompt,
            runId,
            runtime: this.runtime,
            turnId,
            cwd: root,
            threadId: snapshot.providerSession?.providerThreadId,
            onBeforeTerminal: async (succeeded) => {
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
          const turnProvider = this.provider.resolveTurn?.({ modelId: DEFAULT_MODEL_ID, thinkingLevel: "none" });
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
              turnId,
              reviewCommentIds: providerIntent.reviewCommentIds ?? reviewComments.map((comment) => comment.commentId),
              claimSteering: async () => activeTurn.steering.splice(0),
            });
            const afterCheckpoint = root && !result.pending ? await captureKernelCheckpoint({ root, runId, turnId, phase: "after" }) : undefined;
            const workspaceDiff = root && !result.pending ? await captureKernelDiff({ root, runId, turnId }) : undefined;
            const terminalEvent = result.events.at(-1);
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
            return [
              ...(beforeCheckpoint ? [beforeCheckpoint] : []),
              ...providerEvents,
              ...(afterCheckpoint ? [afterCheckpoint] : []),
              ...(workspaceDiff ? [workspaceDiff] : []),
              ...reviewResolutions,
              ...(terminalEvent ? [terminalEvent] : []),
            ].map((normalizedEvent) => ({
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
        return [
          ...(beforeCheckpoint ? [beforeCheckpoint] : []),
          ...(afterCheckpoint ? [afterCheckpoint] : []),
          ...(workspaceDiff ? [workspaceDiff] : []),
        ].map((normalizedEvent) => ({
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
        const turnProvider = this.provider.resolveTurn?.({ modelId: DEFAULT_MODEL_ID, thinkingLevel: "none" });
        if (!turnProvider) throw new Error("Kernel provider router does not support agentic turns");
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
            claimSteering: async () => activeTurn.steering.splice(0),
          });
          const afterCheckpoint = await captureKernelCheckpoint({ root, runId: effect.runId, turnId: effect.intent.turnId, phase: "after" });
          const workspaceDiff = await captureKernelDiff({ root, runId: effect.runId, turnId: effect.intent.turnId });
          const reviewResolutions = result.reviewCommentIds
            ? reviewCommentResolutionEvents({ commentIds: result.reviewCommentIds, runId: effect.runId, turnId: effect.intent.turnId })
            : [];
          return [...result.events, afterCheckpoint, workspaceDiff, ...reviewResolutions].map((normalizedEvent) => ({
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
    this.codexAdapter?.close();
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
        console.error("Kernel daemon: poll failed", error);
      }
    }
    this.pollInFlight = false;
    this.tracer.endSpan(span);
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
        console.error(
          "Kernel daemon: completion report failed — command remains claimed for redelivery",
          commandId,
          status,
          error instanceof Error ? error.message : error,
        );
      }
    };

    try {
      switch (kind) {
        case "run.create": {
          const projectId = (payload.projectId ?? "default") as string;
          if (typeof payload.projectPath === "string" && payload.projectPath.length > 0 && runId) {
            this.projectPathByRun.set(runId, payload.projectPath);
          }
          // `runId` is the canonical ID assigned at command ingress
          // (submitToInbox defaults it to the thread ID). The local run
          // must be created under this exact ID — otherwise the
          // client-visible run identity a browser/projection reader knows
          // about can never be found by a later run.resume/turn.send that
          // references the same canonical ID.
          await this.runtime.createRun({ projectId, runId: runId as never });
          incrementMetric("activeRuns");
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
          const deps = this.config.adapterDeps;
          if (!deps?.resolveProjectRoot) {
            throw new Error(
              "subagent.run requires resolveProjectRoot adapter dep",
            );
          }
          const subEvents = await executeSubagent(
            {
              task: (payload.task ?? "") as string,
              roleName: (payload.roleName ?? "worker") as string,
              capabilities: (payload.capabilities ?? []) as Capability[],
              projectPath: (payload.projectPath ?? ".") as string,
              threadId: (payload.threadId ?? "") as string,
              modelId: payload.modelId as string | undefined,
            },
            {
              provider: this.provider,
              platform: deps.platform ?? "linux",
              resolveProjectRoot: deps.resolveProjectRoot,
            },
            runId ?? `sub-${commandId}`,
          );
          for (const ev of subEvents) {
            const eventType = ev.type as
              | "activity.started"
              | "activity.delta"
              | "activity.completed"
              | "activity.failed"
              | "usage.recorded"
              | "checkpoint.captured";
            await appendAdapterEvent(this.runtime, runId ?? `sub-${commandId}`, {
              eventId: ev.eventId,
              type: eventType,
              payload: ev.payload,
            });
          }
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
      await complete("rejected");
    } finally {
      stopRenewal?.();
      this.canaryTelemetry.activeLeases--;
    }

    this.tracer.endSpan(span);
  }

  private async flush(): Promise<void> {
    await flushProjections({
      deviceToken: this.config.deviceToken,
      runtime: this.runtime,
      projectionSink: this.projectionSink,
      machineId: this.config.machineId,
      telemetry: this.projectionTelemetry,
    });
    this.canaryTelemetry.projectionBacklog = this.projectionTelemetry.backlog;
  }

  private heartbeatCount = 0;
  private async heartbeat(): Promise<void> {
    if (this.shuttingDown) return;
    try {
      this.heartbeatCount++;
      if (this.heartbeatCount % 10 === 0) {
        await this.flush();
      }
      // Log health/metrics every 60 heartbeats (~30s at default 500ms interval)
      if (this.heartbeatCount % 60 === 0) {
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
        console.error("Kernel daemon: device token rejected; shutting down.");
        this.shuttingDown = true;
        process.exit(1);
      }
      console.error("Kernel daemon: heartbeat failed", error);
    }
  }
}

function activeTurnKey(runId: string, turnId: string): string {
  return `${runId}\u0000${turnId}`;
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
