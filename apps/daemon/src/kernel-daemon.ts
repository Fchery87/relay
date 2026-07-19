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

async function executeTurnViaCodex({
  runId,
  prompt,
  codexAdapter,
  runtime,
  threadId,
  onFirstToken,
}: {
  runId: string;
  prompt: string;
  codexAdapter: CodexSessionAdapter;
  runtime: LocalHarnessRuntime;
  threadId?: string;
  onFirstToken?: (latencyMs: number) => void;
}): Promise<boolean> {
  const turnStart = Date.now();
  let firstTokenEmitted = false;
  let succeeded = true;

  const unsub = codexAdapter.onEvent(async (ev: NormalizedEvent) => {
    // Normalize & append each canonical event from the Codex session
    const result = await runtime.appendEvent(runId, {
      eventId: `ev-codex-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...ev,
    } as AppendEventInput);
    if (!result.ok) {
      console.error("Kernel daemon: failed to append Codex event", result.reason);
    }

    // SLO: track first text delta
    if (!firstTokenEmitted && ev.type === "assistant.delta" && onFirstToken) {
      firstTokenEmitted = true;
      onFirstToken(Date.now() - turnStart);
    }

    // Detect terminal states
    if (ev.type === "turn.failed") succeeded = false;

    incrementMetric("eventsProcessed");
  });

  try {
    if (threadId) {
      await codexAdapter.resumeThread(threadId);
    } else {
      await codexAdapter.startThread();
    }
    // Start the turn — Codex notifications stream back via onEvent
    await codexAdapter.startTurn(codexAdapter.activeThreadId ?? "", prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await runtime.appendEvent(runId, {
      eventId: `ev-codex-failed-${runId}-${Date.now()}`,
      type: "turn.failed",
      payload: { error: message },
    });
    console.error("Kernel daemon: Codex turn failed", message);
    succeeded = false;
  }

  unsub();

  if (succeeded) {
    await runtime.appendEvent(runId, {
      eventId: `ev-codex-completed-${runId}-${Date.now()}`,
      type: "turn.completed",
      payload: {},
    });
  } else {
    await runtime.appendEvent(runId, {
      eventId: `ev-codex-failed-terminal-${runId}-${Date.now()}`,
      type: "turn.failed",
      payload: { error: "Codex turn failed" },
    });
  }

  return succeeded;
}

// ---------------------------------------------------------------------------
// Turn executor — bridges the provider into the kernel's event stream
// ---------------------------------------------------------------------------

async function executeTurn({
  runId,
  prompt,
  provider,
  runtime,
  onFirstToken,
}: {
  runId: string;
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
        const result = await runtime.appendEvent(runId, {
          eventId: `ev-delta-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: "assistant.delta",
          payload: { text: sanitizedText },
        });
        if (!result.ok) {
          console.error("Kernel daemon: failed to append assistant.delta", result.reason);
        }
        incrementMetric("eventsProcessed");
      } else if (streamEvent.kind === "usage") {
        const result = await runtime.appendEvent(runId, {
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
    await runtime.appendEvent(runId, {
      eventId: `ev-failed-${runId}-${Date.now()}`,
      type: "turn.failed",
      payload: { error: message },
    });
    console.error("Kernel daemon: turn failed", message);
  }

  if (turnSucceeded) {
    await runtime.appendEvent(runId, {
      eventId: `ev-completed-${runId}-${Date.now()}`,
      type: "turn.completed",
      payload: {},
    });
  } else {
    await runtime.appendEvent(runId, {
      eventId: `ev-failed-terminal-${runId}-${Date.now()}`,
      type: "turn.failed",
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
  return runtime.appendEvent(runId, input as AppendEventInput);
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

  constructor(private readonly config: KernelDaemonConfig) {}

  async start(): Promise<void> {
    const startSpan = this.tracer.startSpan("daemon.start");

    // 1. Open the local SQLite store
    const dbPath = join(this.config.daemonHome, "relay-kernel.sqlite");
    this.runtime = LocalHarnessRuntime.open(dbPath, {
      maxConcurrentRuns: 4,
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
    }, this.config.pollIntervalMs ?? 200);

    // Graceful shutdown via supervisor
    const shutdown = async () => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      clearInterval(heartbeatInterval);
      clearInterval(pollInterval);
      this.codexAdapter?.close();
      await this.flush();
      this.runtime.close();
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

  private async poll(): Promise<void> {
    if (this.shuttingDown) return;
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
          const modelId = (payload.modelId as string) ?? DEFAULT_MODEL_ID;

          // Security: scan prompt for secrets before sending to provider
          const secretFindings = scanForSecrets(rawPrompt);
          if (secretFindings.length > 0) {
            console.warn("Kernel daemon: secrets detected in prompt:", secretFindings);
            throw new Error("Prompt contains credentials — rejected by security scan");
          }
          // Sanitize prompt before logging/projection
          const prompt = sanitizeForProjection(rawPrompt);

          await this.runtime.sendTurn({ runId: rId as never, prompt });

          let succeeded: boolean;
          const turnStart = Date.now();

          if (this.codexAdapter) {
            // Real Codex app-server path
            succeeded = await executeTurnViaCodex({
              runId: rId,
              prompt,
              codexAdapter: this.codexAdapter,
              runtime: this.runtime,
              threadId: payload.threadId as string | undefined,
              onFirstToken: (latencyMs) => {
                this.firstTokenLatencies.push(latencyMs);
              },
            });
          } else {
            // Catalog LLM provider path (legacy / fake)
            const turnProvider = this.provider.resolve({
              modelId,
              thinkingLevel:
                (payload.thinkingLevel as "none" | "low" | "medium" | "high") ??
                "none",
            });

            succeeded = await executeTurn({
              runId: rId,
              prompt,
              provider: turnProvider,
              runtime: this.runtime,
              onFirstToken: (latencyMs) => {
                this.firstTokenLatencies.push(latencyMs);
              },
            });
          }

          const turnLatency = Date.now() - turnStart;

          if (succeeded) {
            incrementMetric("completedRuns");
          } else {
            incrementMetric("failedRuns");
          }

          span.tags["turnLatencyMs"] = String(turnLatency);
          span.tags["turnSucceeded"] = String(succeeded);
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
