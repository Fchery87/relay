import type {
  CanonicalEventDraft,
  RunSnapshot,
  EventEnvelope,
  CanonicalEventType,
  ReactorRegistry,
} from "@relay/contracts";
import {
  openMemoryStore,
  openStore,
  getSnapshot,
  getEventsAfter,
  getEventCommitVersion,
  waitForEventCommit,
} from "@relay/local-store";
import type { StoreDatabase } from "@relay/local-store";
import { OrchestrationEngine } from "@relay/orchestration";
import {
  type HarnessRuntime,
  type CreateRunInput,
  type ResumeRunInput,
  type SendTurnInput,
  type SteerTurnInput,
  type InterruptTurnInput,
  type ResolveApprovalInput,
  type StopRunInput,
  type SnapshotInput,
  type ObserveInput,
  type TurnReceipt,
  type AppendEventInput,
  type AppendEventResult,
} from "./harness-runtime";

export type LocalHarnessRuntimeConfig = {
  readonly maxConcurrentRuns?: number;
  readonly reactors?: ReactorRegistry;
  readonly reactorLeaseMs?: number;
  readonly reactorBatchSize?: number;
  readonly reactorMaxAttempts?: number;
};

export class LocalHarnessRuntime implements HarnessRuntime {
  private readonly engine: OrchestrationEngine;
  private readonly closeController = new AbortController();

  constructor(
    private readonly db: StoreDatabase,
    config?: LocalHarnessRuntimeConfig,
  ) {
    this.engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: config?.maxConcurrentRuns ?? 4,
      reactors: config?.reactors,
      reactorLeaseMs: config?.reactorLeaseMs,
      reactorBatchSize: config?.reactorBatchSize,
      reactorMaxAttempts: config?.reactorMaxAttempts,
    });
  }

  /** Open a persistent file-backed runtime. */
  static open(path: string, config?: LocalHarnessRuntimeConfig): LocalHarnessRuntime {
    return new LocalHarnessRuntime(openStore(path), config);
  }

  /** Open an in-memory runtime (for tests). */
  static memory(config?: LocalHarnessRuntimeConfig): LocalHarnessRuntime {
    return new LocalHarnessRuntime(openMemoryStore(), config);
  }

  // -- HarnessRuntime impl ---------------------------------------------------

  async createRun(input: CreateRunInput): Promise<RunSnapshot> {
    return this.engine.createRun(input);
  }

  async resumeRun(input: ResumeRunInput): Promise<RunSnapshot> {
    return this.engine.submit({
      schemaVersion: 1,
      commandId: `cmd-resume-${input.runId}` as never,
      type: "run.resume",
      runId: input.runId,
      correlationId: `corr-resume` as never,
      actor: { kind: "system", id: "harness" },
      issuedAt: Date.now(),
      payload: {},
    });
  }

  async sendTurn(input: SendTurnInput): Promise<TurnReceipt> {
    const commandId =
      input.commandId ?? (`cmd-send-${crypto.randomUUID()}` as never);
    const turnId =
      input.turnId ?? (`turn-${commandId}` as never);

    const receipt = await this.engine.submitReceipt({
      schemaVersion: 1,
      commandId,
      type: "turn.send",
      runId: input.runId,
      correlationId: `corr-send` as never,
      actor: { kind: "user", id: "user" },
      issuedAt: Date.now(),
      payload: { prompt: input.prompt, turnId },
    });

    if (receipt.kind !== "turn") {
      throw new Error(`Expected a turn receipt for command ${commandId}`);
    }
    return { turnId: receipt.turnId, commandId: receipt.commandId };
  }

  async steerTurn(input: SteerTurnInput): Promise<void> {
    await this.engine.submit({
      schemaVersion: 1,
      commandId: `cmd-steer-${crypto.randomUUID()}` as never,
      type: "turn.steer",
      runId: input.runId,
      correlationId: `corr-steer` as never,
      actor: { kind: "user", id: "user" },
      issuedAt: Date.now(),
      payload: { steering: input.steering },
    });
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    await this.engine.submit({
      schemaVersion: 1,
      commandId: `cmd-interrupt-${crypto.randomUUID()}` as never,
      type: "turn.interrupt",
      runId: input.runId,
      correlationId: `corr-int` as never,
      actor: { kind: "user", id: "user" },
      issuedAt: Date.now(),
      payload: { reason: input.reason ?? "user" },
    });
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<void> {
    await this.engine.submit({
      schemaVersion: 1,
      commandId: `cmd-approve-${crypto.randomUUID()}` as never,
      type: "approval.resolve",
      runId: input.runId,
      correlationId: `corr-approve` as never,
      actor: { kind: "user", id: "user" },
      issuedAt: Date.now(),
      payload: { approvalId: input.approvalId, resolution: input.resolution },
    });
  }

  async stopRun(input: StopRunInput): Promise<void> {
    await this.engine.submit({
      schemaVersion: 1,
      commandId: `cmd-stop-${crypto.randomUUID()}` as never,
      type: "run.stop",
      runId: input.runId,
      correlationId: `corr-stop` as never,
      actor: { kind: "user", id: "user" },
      issuedAt: Date.now(),
      payload: { reason: input.reason ?? "user" },
    });
  }

  async snapshot(input: SnapshotInput): Promise<RunSnapshot> {
    const snap = getSnapshot(this.db, input.runId as string);
    if (!snap) throw new Error(`Run not found: ${input.runId}`);
    return snap;
  }

  async *observe(input: ObserveInput): AsyncIterable<EventEnvelope<CanonicalEventType, unknown>> {
    const runId = input.runId;
    let cursor = input.afterSequence ?? -1;
    let notificationVersion = getEventCommitVersion(this.db, runId);
    const combined = combineAbortSignals(input.signal, this.closeController.signal);

    try {
      while (!combined.signal.aborted) {
        const events = getEventsAfter(this.db, runId, cursor);
        for (const event of events) {
          if (combined.signal.aborted) return;
          cursor = event.sequence;
          yield event;
        }

        const snapshot = getSnapshot(this.db, runId);
        if (!snapshot) throw new Error(`Run not found: ${runId}`);
        if (isTerminal(snapshot.status)) return;

        const latestVersion = getEventCommitVersion(this.db, runId);
        if (latestVersion !== notificationVersion) {
          notificationVersion = latestVersion;
          continue;
        }

        notificationVersion = await waitForEventCommit(
          this.db,
          runId,
          notificationVersion,
          combined.signal,
        );
      }
    } finally {
      combined.dispose();
    }
  }

  /** Close the underlying database connection (if file-backed). */
  close(): void {
    if (this.closeController.signal.aborted) return;
    this.closeController.abort();
    this.db.close();
  }

  // -- Extended methods (not in HarnessRuntime, used by kernel daemon) -----

  async appendEvent(runId: string, input: AppendEventInput): Promise<AppendEventResult> {
    const commandId = `cmd-event-${input.eventId}` as never;
    const correlationId = (input.correlationId ?? `corr-${input.eventId}`) as never;

    try {
      const snapshot = await this.engine.submit({
        schemaVersion: 1,
        commandId,
        type: "provider.event",
        runId: runId as never,
        correlationId,
        actor: { kind: "provider", id: "local-provider" },
        issuedAt: Date.now(),
        payload: {
          providerInstanceId: "provider-local" as never,
          normalizedEvent: toCanonicalEventDraft(
            input,
            correlationId,
            commandId,
          ),
        },
      });
      return { ok: true, sequence: snapshot.sequence };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  listRuns(): ReadonlyArray<{ runId: string; status: string }> {
    const rows = this.db
      .query("SELECT run_id, status FROM run_snapshots ORDER BY updated_at DESC")
      .all() as Array<{ run_id: string; status: string }>;
    return rows.map((r) => ({ runId: r.run_id, status: r.status }));
  }

  getSnapshotByRunId(runId: string): RunSnapshot | undefined {
    return getSnapshot(this.db, runId) ?? undefined;
  }

  /** Execute one bounded batch of reclaimable durable effects. */
  drainEffects(): Promise<number> {
    return this.engine.drainEffects();
  }
}

function toCanonicalEventDraft(
  input: AppendEventInput,
  correlationId: CanonicalEventDraft["correlationId"],
  causationId: NonNullable<CanonicalEventDraft["causationId"]>,
): CanonicalEventDraft {
  return {
    ...input,
    eventId: input.eventId as never,
    correlationId,
    causationId,
  } as CanonicalEventDraft;
}

function isTerminal(status: RunSnapshot["status"]): boolean {
  return status === "stopped" || status === "completed" || status === "failed";
}

function combineAbortSignals(
  ...signals: ReadonlyArray<AbortSignal | undefined>
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const activeSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const abort = () => controller.abort();

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of activeSignals) {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
