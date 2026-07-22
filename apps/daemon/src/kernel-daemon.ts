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
import type { EffectReactor } from "@relay/contracts";
import {
  canonicalEventPayloadError,
  canonicalEventRequiresTurn,
} from "@relay/contracts";
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
import type { Policy } from "./policy";
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KernelDaemonConfig = {
  daemonHome: string;
  deploymentUrl: string;
  deviceToken: string;
  heartbeatIntervalMs: number;
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
  onFirstToken?: (latencyMs: number) => void;
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
  onFirstToken,
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
        if (
          ev.type === "turn.completed" ||
          ev.type === "turn.failed" ||
          ev.type === "turn.interrupted"
        ) {
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
      await codexAdapter.resumeThread(threadId);
    } else {
      await codexAdapter.startThread();
    }
    expectedProviderThreadId = codexAdapter.activeThreadId ?? undefined;
    if (!expectedProviderThreadId) {
      throw new Error("Codex did not provide a native thread ID");
    }
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

async function executeTurn({
  runId,
  turnId,
  prompt,
  provider,
  runtime,
  onFirstToken,
}: {
  runId: string;
  turnId: string;
  prompt: string;
  provider: ModelProvider;
  runtime: LocalHarnessRuntime;
  onFirstToken?: (latencyMs: number) => void;
}): Promise<boolean> {
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
// Projection publisher
// ---------------------------------------------------------------------------

async function flushProjections({
  deviceToken,
  runtime,
  projectionSink,
}: {
  deviceToken: string;
  runtime: LocalHarnessRuntime;
  projectionSink: ProjectionSink;
}): Promise<void> {
  try {
    const runs = runtime.listRuns();
    for (const run of runs) {
      const snapshot = runtime.getSnapshotByRunId(run.runId);
      if (!snapshot) continue;

      await projectionSink.upsertSnapshot({
        projectId: snapshot.projectId as string,
        runId: snapshot.runId as string,
        sequence: snapshot.sequence,
        snapshotJson: JSON.stringify(snapshot),
        deviceToken,
      });
    }
  } catch (error) {
    console.error("Kernel daemon: projection flush failed", error);
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
  private shuttingDown = false;
  private tracer = new Tracer();
  private supervisor!: DaemonSupervisor;
  private firstTokenLatencies: number[] = [];

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

  constructor(private readonly config: KernelDaemonConfig) {}

  async start(): Promise<void> {
    const startSpan = this.tracer.startSpan("daemon.start");

    // 1. Open the local SQLite store with a reactor registry so the
    // orchestration engine can drain provider, workspace, checkpoint,
    // and approval effects through registered reactors.
    const dbPath = join(this.config.daemonHome, "relay-kernel.sqlite");
    const reactors = new MutableReactorRegistry();
    this.runtime = LocalHarnessRuntime.open(dbPath, {
      maxConcurrentRuns: resolveMaxConcurrentRuns(Bun.env as Record<string, string | undefined>),
      reactors: reactors.build(),
    });

    // 2. Create the provider
    const fallback = new ScriptedModelProvider({
      chunks: ["Relay kernel received your message."],
    });
    this.provider = new LocalModelRouter({
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
      execute: async (effect, _context) => {
        if (effect.intent.kind !== "provider.send_turn") {
          throw new Error(`Unexpected effect kind: ${effect.intent.kind}`);
        }
        const { runId } = effect;
        const { turnId, prompt } = effect.intent;
        if (codexEnabled && codex) {
          await executeTurnViaCodex({
            codexAdapter: codex,
            prompt,
            runId,
            runtime: this.runtime,
            turnId,
          });
        } else {
          await executeTurn({
            provider: this.provider as unknown as Parameters<typeof executeTurn>[0]["provider"],
            prompt,
            runId,
            runtime: this.runtime,
            turnId,
          });
        }
        return [];
      },
      recover: async () => [],
    };
    reactors.register("provider.send_turn", providerReactor);

    // Register no-op reactors for provider lifecycle, workspace, checkpoint,
    // approval, and tool effects — these are routed through the existing
    // adapter infrastructure and don't need new side effects in the daemon.
    const noopReactor: EffectReactor = {
      execute: async () => [],
      recover: async () => [],
    };
    for (const kind of ["provider.start_session", "provider.resume_session", "provider.steer_turn", "provider.interrupt_turn", "provider.resolve_approval", "provider.stop_session", "workspace.create", "workspace.reconcile", "checkpoint.capture", "checkpoint.restore", "tool.execute"] as const) {
      reactors.register(kind, noopReactor);
    }

    // 3. Create Convex adapters
    this.commandGateway = createConvexCommandSource({
      deploymentUrl: this.config.deploymentUrl,
      deviceToken: this.config.deviceToken,
    });
    this.projectionSink = createConvexProjectionSink({
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

    const heartbeatInterval = setInterval(() => {
      void this.heartbeat();
    }, this.config.heartbeatIntervalMs);

    const pollInterval = setInterval(() => {
      void this.poll();
    }, this.config.pollIntervalMs ?? 1_000);

    // Graceful shutdown via supervisor
    const shutdown = async () => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      clearInterval(heartbeatInterval);
      clearInterval(pollInterval);
      this.codexAdapter?.close();
      await this.flush();
      await this.runtime.shutdown();
      this.tracer.endSpan(startSpan);
      const spans = this.tracer.getSpans();
      console.info(
        `Kernel daemon shutting down. ${spans.length} traces recorded.`,
      );
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());

    this.tracer.endSpan(startSpan);
  }

  private pollInFlight = false;

  private async poll(): Promise<void> {
    if (this.shuttingDown || this.pollInFlight) return;
    this.pollInFlight = true;
    const span = this.tracer.startSpan("daemon.poll");
    try {
      const batch = await this.commandGateway.claimBatch({
        deviceToken: this.config.deviceToken,
        leaseDurationMs: 30_000,
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

        await this.processCommand(cmd.commandId, cmd.externalCommandId, cmd.kind, payload, cmd.runId, cmd.leaseGeneration);
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
  ): Promise<void> {
    const span = this.tracer.startSpan(`command.${kind}`);
    span.tags["commandId"] = commandId;

    const complete = (status: "completed" | "rejected") =>
      this.commandGateway.completeCommand({
        commandId,
        deviceToken: this.config.deviceToken,
        leaseGeneration: leaseGeneration ?? 0,
        status,
      });

    try {
      switch (kind) {
        case "run.create": {
          const projectId = (payload.projectId ?? "default") as string;
          await this.runtime.createRun({ projectId });
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
          incrementMetric("completedRuns");
          await complete("completed");
          break;
        }
        case "turn.send": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("turn.send requires runId");
          const rawPrompt = (payload.prompt ?? "Hello") as string;

          // Security: scan prompt for secrets before sending to provider
          const secretFindings = scanForSecrets(rawPrompt);
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
          });

          const drained = await this.runtime.drainEffects();
          const turnLatency = Date.now() - turnStart;

          // Determine success from the canonical run state after draining.
          const snapshot = this.runtime.getSnapshotByRunId(rId);
          const succeeded = snapshot?.status === "completed" || snapshot?.status === "ready" || snapshot?.status === "running";

          if (succeeded) {
            incrementMetric("completedRuns");
          } else {
            incrementMetric("failedRuns");
          }

          span.tags["turnLatencyMs"] = String(turnLatency);
          span.tags["turnSucceeded"] = String(succeeded);
          span.tags["effectsDrained"] = String(drained);
          await complete(succeeded ? "completed" : "rejected");
          break;
        }
        case "checkpoint.restore": {
          if (!this.config.adapterDeps?.resolveProjectRoot) {
            throw new Error("checkpoint.restore requires resolveProjectRoot adapter dep");
          }
          const ckptEvents = await executeCheckpointRestore(
            {
              commit: (payload.commit ?? "HEAD") as string,
              projectPath: (payload.projectPath ?? ".") as string,
              threadId: (payload.threadId ?? "") as string,
            },
            {
              resolveProjectRoot: this.config.adapterDeps.resolveProjectRoot,
            },
            runId ?? `ckpt-${commandId}`,
          );
          for (const ev of ckptEvents) {
            await appendAdapterEvent(this.runtime, runId ?? `ckpt-${commandId}`, {
              eventId: ev.eventId,
              type: ev.type as "checkpoint.restored" | "activity.completed",
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
              toCommit: (payload.toCommit ?? "HEAD") as string,
              projectPath: (payload.projectPath ?? ".") as string,
              threadId: (payload.threadId ?? "") as string,
            },
            {
              resolveProjectRoot: this.config.adapterDeps.resolveProjectRoot,
            },
            runId ?? `cmp-${commandId}`,
          );
          for (const ev of cmpEvents) {
            await appendAdapterEvent(this.runtime, runId ?? `cmp-${commandId}`, {
              eventId: ev.eventId,
              type: "activity.completed" as const,
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
    }

    this.tracer.endSpan(span);
  }

  private async flush(): Promise<void> {
    await flushProjections({
      deviceToken: this.config.deviceToken,
      runtime: this.runtime,
      projectionSink: this.projectionSink,
    });
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
