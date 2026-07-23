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
  listRunDiagnostics,
  waitForEventCommit,
  claimOutboxBatch,
  acknowledgeOutboxBatch,
  countPendingOutbox,
  enforceRetention,
  type RetentionResult,
} from "@relay/local-store";
import type { RunDiagnostic, StoreDatabase, OutboxRow } from "@relay/local-store";
import { createWorkflowReactors, OrchestrationEngine, type WorkflowChildExecutor } from "@relay/orchestration";
import { DurableTaskStore } from "@relay/local-store";
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
  readonly reactorRetryBaseMs?: number;
  readonly reactorRetryMaxMs?: number;
  readonly reactorRetryJitterRatio?: number;
  readonly reactorNow?: () => number;
  /** Enable sandbox enforcement for process and filesystem access. */
  readonly sandbox?: SandboxConfig;
  readonly workflowChildExecutor?: WorkflowChildExecutor;
};

/** Sandbox configuration — restricts process execution and filesystem access. */
export type SandboxConfig = {
  /** Allowed workspace root paths (processes cannot escape these). */
  readonly workspaceRoots: ReadonlyArray<string>;
  /** Environment variables allowed through to subprocesses. */
  readonly envAllowlist?: ReadonlyArray<string>;
  /** Fail closed — if true, sandbox enforcement failure blocks execution. */
  readonly failClosed: boolean;
};

export class LocalHarnessRuntime implements HarnessRuntime {
  private readonly engine: OrchestrationEngine;
  private readonly closeController = new AbortController();
  private closePromise?: Promise<void>;

  constructor(
    private readonly db: StoreDatabase,
    private readonly config?: LocalHarnessRuntimeConfig,
  ) {
    const workflowReactors = createWorkflowReactors(db, {
      executeChild: config?.workflowChildExecutor,
    });
    this.engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: config?.maxConcurrentRuns ?? 4,
      reactors: { ...workflowReactors, ...config?.reactors },
      reactorLeaseMs: config?.reactorLeaseMs,
      reactorBatchSize: config?.reactorBatchSize,
      reactorMaxAttempts: config?.reactorMaxAttempts,
      reactorRetryBaseMs: config?.reactorRetryBaseMs,
      reactorRetryMaxMs: config?.reactorRetryMaxMs,
      reactorRetryJitterRatio: config?.reactorRetryJitterRatio,
      reactorNow: config?.reactorNow,
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
      payload: {
        prompt: input.prompt,
        ...(input.reviewComments ? { reviewComments: input.reviewComments } : {}),
        ...(input.reviewCommentIds ? { reviewCommentIds: input.reviewCommentIds } : {}),
        turnId,
      },
    });

    if (receipt.kind !== "turn") {
      throw new Error(`Expected a turn receipt for command ${commandId}`);
    }
    return { turnId: receipt.turnId, commandId: receipt.commandId };
  }

  async startWorkflow(input: {
    readonly runId: string;
    readonly workflowKind: string;
    readonly task: import("@relay/contracts").TaskSpec;
  }): Promise<RunSnapshot> {
    return this.engine.submit({
      schemaVersion: 1,
      commandId: `cmd-workflow-${input.task.taskId}` as never,
      type: "workflow.start",
      runId: input.runId as never,
      correlationId: `corr-workflow-${input.task.taskId}` as never,
      actor: { kind: "system", id: "kernel-workflow" },
      issuedAt: Date.now(),
      payload: { workflowKind: input.workflowKind, task: input.task },
    });
  }

  async runWorkflow(input: {
    readonly runId: string;
    readonly workflowKind: string;
    readonly task: import("@relay/contracts").TaskSpec;
  }): Promise<import("@relay/contracts").TaskSpec | undefined> {
    await this.startWorkflow(input);
    await this.engine.drainWorkflowEffects();
    return new DurableTaskStore(this.db).get(input.task.taskId);
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

  /** Run bounded local-store maintenance without exposing the SQLite handle. */
  maintain(options?: { readonly now?: number; readonly vacuum?: boolean }): RetentionResult {
    return enforceRetention(this.db, options);
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
    void this.shutdown();
  }

  /** Fence new work, abort reactors, and close storage after in-flight work settles. */
  shutdown(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeController.abort();
    this.closePromise = this.engine.close().finally(() => {
      this.db.close();
    });
    return this.closePromise;
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

  listRunDiagnostics(runId: string): ReadonlyArray<RunDiagnostic> {
    return listRunDiagnostics(this.db, runId);
  }

  /**
   * Claim a bounded batch of unpublished projection-outbox rows under a
   * durable lease. Rows already leased (and not expired) are skipped, so a
   * crashed publisher's claim is naturally reclaimable once the lease
   * expires. Callers must acknowledge only after durable remote confirmation.
   */
  claimProjectionOutbox(input: {
    readonly owner: string;
    readonly leaseDurationMs: number;
    readonly limit: number;
  }): OutboxRow[] {
    return claimOutboxBatch(this.db, input.owner, input.leaseDurationMs, input.limit);
  }

  /** Acknowledge outbox rows as durably published; never re-published after this. */
  acknowledgeProjectionOutbox(ids: readonly number[]): void {
    acknowledgeOutboxBatch(this.db, ids);
  }

  /** Backlog observability: count of unpublished outbox rows and the oldest one's age. */
  countPendingProjectionOutbox(): { count: number; oldestOccurredAt: number | null; maxId: number | null } {
    return countPendingOutbox(this.db);
  }

  /** Execute one bounded batch of reclaimable durable effects. */
  drainEffects(): Promise<number> {
    return this.engine.drainEffects();
  }

  /** Drain steer/interrupt effects without waiting behind a provider turn. */
  drainControlEffects(): Promise<number> {
    return this.engine.drainControlEffects();
  }

  // -- Sandbox enforcement ---------------------------------------------------

  /**
   * Validate that a filesystem path is within an allowed workspace root.
   * Resolves symlinks before comparison to prevent traversal escapes.
   * Throws if sandbox enforcement is enabled and the path escapes.
   */
  async enforceSandboxPath(requestedPath: string): Promise<string> {
    const cfg = this.config?.sandbox;
    if (!cfg) return requestedPath;

    // Resolve symlinks to prevent symlink-traversal escapes.
    let resolved = requestedPath;
    try {
      const fs = await import("node:fs/promises");
      resolved = await fs.realpath(requestedPath);
    } catch {
      // Path doesn't exist yet — validate the parent instead.
      const parent = requestedPath.split("/").slice(0, -1).join("/") || "/";
      const fs = await import("node:fs/promises");
      resolved = await fs.realpath(parent) + "/" + requestedPath.split("/").pop()!;
    }

    // Verify the resolved path is within an allowed root.
    const allowed = cfg.workspaceRoots.some((root) =>
      resolved.startsWith(root.endsWith("/") ? root : root + "/"),
    );

    if (!allowed) {
      const message = `Sandbox violation: path "${requestedPath}" (resolved: "${resolved}") escapes workspace roots`;
      if (cfg.failClosed) throw new Error(message);
      console.warn(message);
    }

    return resolved;
  }

  /**
   * Filter environment variables to only those on the allowlist.
   * Returns a sanitized env object when sandbox is configured.
   */
  filterSandboxEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
    const cfg = this.config?.sandbox;
    if (!cfg?.envAllowlist) return env;
    const allowed = new Set(cfg.envAllowlist);
    const filtered: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      if (allowed.has(key)) filtered[key] = value;
    }
    return filtered;
  }

  /** Whether sandbox enforcement is enabled. */
  get sandboxEnabled(): boolean {
    return this.config?.sandbox?.failClosed ?? false;
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
