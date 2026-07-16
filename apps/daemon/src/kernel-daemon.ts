// ---------------------------------------------------------------------------
// Kernel daemon — the kernel-mode daemon runner.
// Wires LocalHarnessRuntime + Convex command gateway/projection sink + provider
// into a single polling loop, replacing the legacy per-work-type pollers.
//
// Activated when RELAY_RUNTIME_MODE=kernel or shadow.
// ---------------------------------------------------------------------------

import { hostname } from "node:os";
import { join } from "node:path";

import { isDeviceTokenRejected } from "./device-auth";
import { LocalHarnessRuntime } from "@relay/harness-runtime";
import { DEFAULT_MODEL_ID } from "@relay/shared";
import {
  createConvexCommandSource,
} from "./sync/convex-command-source";
import type { CommandGateway } from "./sync/convex-command-source";
import {
  createConvexProjectionSink,
} from "./sync/convex-projection-sink";
import type { ProjectionSink } from "./sync/convex-projection-sink";
import type { ModelProvider, ModelProviderRouter } from "./model-provider";
import { ScriptedModelProvider } from "./model-provider";
import { LocalModelRouter } from "./catalog-provider-router";

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
};

// ---------------------------------------------------------------------------
// Turn executor — bridges the provider into the kernel's event stream
// ---------------------------------------------------------------------------

async function executeTurn({
  runId,
  prompt,
  provider,
  runtime,
}: {
  runId: string;
  prompt: string;
  provider: ModelProvider;
  runtime: LocalHarnessRuntime;
}): Promise<boolean> {
  const signal = AbortSignal.timeout(10 * 60 * 1000); // 10-min turn timeout
  let turnSucceeded = false;

  try {
    for await (const streamEvent of provider.streamReply({ prompt, signal })) {
      if (streamEvent.kind === "text") {
        const result = await runtime.appendEvent(runId, {
          eventId: `ev-delta-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: "assistant.delta",
          payload: { text: streamEvent.text },
        });
        if (!result.ok) {
          console.error("Kernel daemon: failed to append assistant.delta", result.reason);
        }
      } else if (streamEvent.kind === "usage") {
        const result = await runtime.appendEvent(runId, {
          eventId: `ev-usage-${runId}-${Date.now()}`,
          type: "usage.recorded",
          payload: streamEvent.usage as unknown as Record<string, unknown>,
        });
        if (!result.ok) {
          console.error("Kernel daemon: failed to append usage.recorded", result.reason);
        }
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

  await runtime.appendEvent(runId, {
    eventId: `ev-completed-${runId}-${Date.now()}`,
    type: turnSucceeded ? "turn.completed" : "turn.failed",
    payload: {},
  });

  return turnSucceeded;
}

// ---------------------------------------------------------------------------
// Projection publisher
// ---------------------------------------------------------------------------

async function flushProjections({
  runtime,
  projectionSink,
}: {
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
  private shuttingDown = false;

  constructor(private readonly config: KernelDaemonConfig) {}

  async start(): Promise<void> {
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

    // 3. Create Convex adapters
    this.commandGateway = createConvexCommandSource({
      deploymentUrl: this.config.deploymentUrl,
      deviceToken: this.config.deviceToken,
    });
    this.projectionSink = createConvexProjectionSink({
      deploymentUrl: this.config.deploymentUrl,
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

    const shutdown = async () => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      clearInterval(heartbeatInterval);
      clearInterval(pollInterval);
      await this.flush();
      this.runtime.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  }

  private async poll(): Promise<void> {
    if (this.shuttingDown) return;
    try {
      const batch = await this.commandGateway.claimBatch({
        deviceToken: this.config.deviceToken,
        leaseDurationMs: 30_000,
        limit: 5,
      });

      for (const cmd of batch) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(cmd.payloadJson ?? "{}") as Record<string, unknown>;
        } catch {
          // invalid json — reject
          await this.commandGateway.completeCommand({
            commandId: cmd.commandId,
            deviceToken: this.config.deviceToken,
            status: "rejected",
          });
          continue;
        }

        await this.processCommand(cmd.commandId, cmd.kind, payload, cmd.runId);
      }
    } catch (error) {
      if (!this.shuttingDown) {
        console.error("Kernel daemon: poll failed", error);
      }
    }
  }

  private async processCommand(
    commandId: string,
    kind: string,
    payload: Record<string, unknown>,
    runId?: string,
  ): Promise<void> {
    const complete = (status: "completed" | "rejected") =>
      this.commandGateway.completeCommand({
        commandId,
        deviceToken: this.config.deviceToken,
        status,
      });

    try {
      switch (kind) {
        case "run.create": {
          const projectId = (payload.projectId ?? "default") as string;
          await this.runtime.createRun({ projectId });
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
          await complete("completed");
          break;
        }
        case "turn.send": {
          const rId = runId ?? (payload.runId as string);
          if (!rId) throw new Error("turn.send requires runId");
          const prompt = (payload.prompt ?? "Hello") as string;
          const modelId = (payload.modelId as string) ?? DEFAULT_MODEL_ID;

          await this.runtime.sendTurn({ runId: rId as never, prompt });

          const turnProvider = this.provider.resolve({
            modelId,
            thinkingLevel:
              (payload.thinkingLevel as "none" | "low" | "medium" | "high") ??
              "none",
          });

          const succeeded = await executeTurn({
            runId: rId,
            prompt,
            provider: turnProvider,
            runtime: this.runtime,
          });

          await complete(succeeded ? "completed" : "rejected");
          break;
        }
        default: {
          // Unknown kind — complete for forward-compat
          console.warn("Kernel daemon: unknown command kind", kind);
          await complete("completed");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Kernel daemon: command failed", commandId, kind, message);
      await complete("rejected");
    }
  }

  private async flush(): Promise<void> {
    await flushProjections({
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
