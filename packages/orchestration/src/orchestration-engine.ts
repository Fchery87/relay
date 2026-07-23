import type {
  CommandReceipt,
  CommandReceiptDraft,
  CreateRunCommand,
  DurableEffect,
  EffectFailureKind,
  EffectIntent,
  EffectRetryClass,
  InternalCommand,
  ReactorCommandDraft,
  ReactorRegistry,
  RunSnapshot,
} from "@relay/contracts";
import { assertCommandSchema } from "@relay/contracts";
import type { Command, ExternalCommand } from "@relay/contracts";
import type { StoreDatabase } from "@relay/local-store";
import {
  claimEffectBatch,
  completeEffect,
  EffectLeaseLostError,
  fenceEffectForFailureRecovery,
  getNextEffectClaimAt,
  releaseEffect,
  renewEffectLease,
  transactCommand,
} from "@relay/local-store";
import { decide } from "./decider";

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

export type EngineConfig = {
  /** Maximum concurrent runs. */
  readonly maxConcurrentRuns: number;
  readonly reactors?: ReactorRegistry;
  readonly reactorLeaseMs?: number;
  readonly reactorBatchSize?: number;
  readonly reactorMaxAttempts?: number;
  readonly reactorRetryBaseMs?: number;
  readonly reactorRetryMaxMs?: number;
  readonly reactorRetryJitterRatio?: number;
  /** Injectable wall clock for deterministic retry/recovery tests. */
  readonly reactorNow?: () => number;
};

export type ReactorFailureOptions = {
  readonly kind: EffectFailureKind;
  readonly message: string;
  readonly retryAfterMs?: number;
};

export class ReactorFailure extends Error {
  readonly kind: EffectFailureKind;
  readonly retryAfterMs?: number;

  constructor(options: ReactorFailureOptions) {
    super(options.message);
    this.name = "ReactorFailure";
    this.kind = options.kind;
    this.retryAfterMs = options.retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Engine — serializes transitions per run, bounds global concurrency.
// ---------------------------------------------------------------------------

export class OrchestrationEngine {
  private readonly activeRuns = new Set<string>();
  private readonly queuedRuns = new Set<string>();
  private readonly readyRuns: string[] = [];
  private readonly runQueues = new Map<string, ScheduledTask[]>();
  private readonly reactorOwner = `reactor-${crypto.randomUUID()}`;
  private readonly activeReactorControllers = new Set<AbortController>();
  private readonly activeTasks = new Set<Promise<void>>();
  private activeDrain?: Promise<number>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly db: StoreDatabase,
    private readonly config: EngineConfig,
  ) {
    if (!Number.isInteger(config.maxConcurrentRuns) || config.maxConcurrentRuns < 1) {
      throw new Error("maxConcurrentRuns must be a positive integer");
    }
    assertNonNegativeFinite(config.reactorRetryBaseMs, "reactorRetryBaseMs");
    assertNonNegativeFinite(config.reactorRetryMaxMs, "reactorRetryMaxMs");
    if (
      config.reactorRetryJitterRatio !== undefined &&
      (!Number.isFinite(config.reactorRetryJitterRatio) ||
        config.reactorRetryJitterRatio < 0 ||
        config.reactorRetryJitterRatio > 1)
    ) {
      throw new Error("reactorRetryJitterRatio must be between 0 and 1");
    }
    this.armNextRetry();
  }

  /**
   * Submit an external or internal command. Returns the resulting snapshot
   * after the command has been durably processed.
   */
  async submit(command: ExternalCommand | InternalCommand): Promise<RunSnapshot> {
    return (await this.submitReceipt(command)).snapshot;
  }

  /** Submit a command and return its immutable durable receipt. */
  async submitReceipt(
    command: ExternalCommand | InternalCommand,
  ): Promise<CommandReceipt> {
    assertCommandSchema(command);
    const runId = command.runId as string;
    return this.schedule(runId, () => this.processCommand(command));
  }

  /**
   * Claim and execute one bounded batch of durable effects.
   * Result commands are idempotent and re-enter the normal command path.
   */
  drainEffects(): Promise<number> {
    if (this.closed) {
      return Promise.reject(new Error("Orchestration engine is closed"));
    }
    const previous = this.activeDrain;
    const pass = previous
      ? previous.then(
          () => this.performDrain(),
          () => this.performDrain(),
        )
      : this.performDrain();
    const drain = pass.finally(() => {
      if (this.activeDrain === drain) this.activeDrain = undefined;
      this.armNextRetry();
    });
    this.activeDrain = drain;
    return drain;
  }

  private async performDrain(): Promise<number> {
    const batchSize = this.config.reactorBatchSize ?? 32;
    const workerCount = Math.min(this.config.maxConcurrentRuns, batchSize);
    let claimed = 0;
    let completed = 0;

    const work = async (): Promise<void> => {
      while (!this.closed && claimed < batchSize) {
        // Claim immediately before execution so queued effects do not burn
        // leases while waiting for a worker slot.
        const [effect] = claimEffectBatch(
          this.db,
          this.reactorOwner,
          this.config.reactorLeaseMs ?? 30_000,
          1,
          this.reactorNow(),
        );
        if (!effect) return;
        claimed++;
        if (await this.executeEffect(effect)) completed++;
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => work()));
    return completed;
  }

  private async executeEffect(effect: DurableEffect): Promise<boolean> {
    if (effect.recoveryFailure) {
      await this.submitEffectCommand(
        effect,
        toEffectFailureCommand(effect, effect.recoveryFailure),
      );
      releaseEffect(
        this.db,
        {
          effectId: effect.effectId,
          owner: this.reactorOwner,
          error: effect.recoveryFailure,
          errorKind: "terminal",
          terminal: true,
          now: this.reactorNow(),
        },
      );
      return false;
    }
    const reactor = this.config.reactors?.[effect.intent.kind];
    if (!reactor) {
      const message = `No reactor registered for ${effect.intent.kind}`;
      await this.submitEffectCommand(
        effect,
        toEffectFailureCommand(effect, message),
      );
      releaseEffect(
        this.db,
        {
          effectId: effect.effectId,
          owner: this.reactorOwner,
          error: message,
          errorKind: "terminal",
          terminal: true,
          now: this.reactorNow(),
        },
      );
      return false;
    }

    const leaseMs = this.config.reactorLeaseMs ?? 30_000;
    const controller = new AbortController();
    this.activeReactorControllers.add(controller);
    let leaseFailure: Error | undefined;
    const renewal = setInterval(() => {
      try {
        if (
          !renewEffectLease(
            this.db,
            effect.effectId,
            this.reactorOwner,
            leaseMs,
            this.reactorNow(),
          )
        ) {
          leaseFailure = new Error(
            `Effect lease ownership was lost: ${effect.effectId}`,
          );
          controller.abort(leaseFailure);
        }
      } catch (error) {
        leaseFailure =
          error instanceof Error ? error : new Error(String(error));
        controller.abort(leaseFailure);
      }
    }, Math.max(1, Math.floor(leaseMs / 3)));

    try {
      const operation =
        effect.attempts === 1 ? reactor.execute : reactor.recover;
      const commands = await operation(effect, {
        idempotencyKey: effect.idempotencyKey,
        signal: controller.signal,
      });
      if (leaseFailure) throw leaseFailure;
      if (
        !renewEffectLease(
          this.db,
          effect.effectId,
          this.reactorOwner,
          leaseMs,
          this.reactorNow(),
        )
      ) {
        throw new EffectLeaseLostError(effect.effectId, "result persistence");
      }
      assertReactorResult(effect, commands);
      let resultSnapshot: RunSnapshot | undefined;
      for (const command of commands) {
        resultSnapshot = await this.submitEffectCommand(
          effect,
          toInternalCommand(effect, command),
        );
      }
      assertEffectPostcondition(effect, resultSnapshot);
      await this.submitEffectCommand(
        effect,
        toEffectSuccessCommand(effect),
      );
      completeEffect(
        this.db,
        effect.effectId,
        this.reactorOwner,
        this.reactorNow(),
      );
      return true;
    } catch (error) {
      if (leaseFailure || error instanceof EffectLeaseLostError) return false;
      const failure = classifyReactorFailure(effect, error);
      const terminal =
        failure.kind === "terminal" ||
        failure.kind === "approval_required" ||
        effect.attempts >= (this.config.reactorMaxAttempts ?? 5);
      if (terminal) {
        try {
          await this.submitEffectCommand(
            effect,
            toEffectFailureCommand(
              effect,
              formatEffectFailure(effect, failure),
            ),
          );
        } catch (resultError) {
          fenceEffectForFailureRecovery(
            this.db,
            effect.effectId,
            this.reactorOwner,
            failure.message,
            this.reactorNow(),
          );
          throw resultError;
        }
      }
      const now = this.reactorNow();
      releaseEffect(
        this.db,
        {
          effectId: effect.effectId,
          owner: this.reactorOwner,
          error: failure.message,
          errorKind: failure.kind,
          terminal,
          ...(terminal
            ? {}
            : {
                nextAttemptAt:
                  now + retryDelayMs(effect, failure, this.config),
              }),
          now,
        },
      );
      return false;
    } finally {
      clearInterval(renewal);
      this.activeReactorControllers.delete(controller);
    }
  }

  // -- creation helpers -------------------------------------------------------

  async createRun(input: {
    readonly projectId: string;
    readonly permissionProfile?: "read-only" | "workspace-write" | "full-access";
    readonly runId?: string;
  }): Promise<RunSnapshot> {
    const runId = (input.runId ?? `run-${crypto.randomUUID()}`) as never;
    const initialSnapshot: RunSnapshot = {
      runId,
      projectId: input.projectId as never,
      status: "created",
      sequence: 0,
      streamVersion: 0,
      restartCount: 0,
      permissionProfile: input.permissionProfile ?? "workspace-write",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const command: CreateRunCommand = {
      schemaVersion: 1,
      commandId: `cmd-create-${runId}` as never,
      type: "run.create",
      runId,
      correlationId: `corr-create-${runId}` as never,
      actor: { kind: "system", id: "harness" },
      issuedAt: Date.now(),
      payload: {
        projectId: input.projectId,
        permissionProfile: input.permissionProfile,
      },
    };
    return (
      await this.schedule(runId, () =>
        this.processCreateCommand(initialSnapshot, command),
      )
    ).snapshot;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async processCreateCommand(
    initialSnapshot: RunSnapshot,
    command: CreateRunCommand,
  ): Promise<CommandReceipt> {
    const appendResult = transactCommand(this.db, {
      runId: command.runId,
      commandId: command.commandId,
      occurredAt: command.issuedAt,
      expectedStreamVersion: initialSnapshot.streamVersion,
      initialSnapshot,
      receipt: { kind: "snapshot" },
      decide: (snapshot) => {
        const result = decide(snapshot, command);
        return {
          nextSnapshot: result.snapshot ?? snapshot,
          events: result.events,
          effects: createEffectDrafts(command, result.effects),
          effectCancellations: result.effectCancellations,
        };
      },
    });

    if (!appendResult.ok) {
      if (appendResult.reason === "duplicate_command") {
        return (
          appendResult.duplicateReceipt ?? createReceipt(command, initialSnapshot)
        );
      }
      throw new Error(`Create run failed: ${appendResult.reason}`);
    }

    return appendResult.receipt;
  }

  private async processCommand(command: Command): Promise<CommandReceipt> {
    return this.processCommandWithFence(command);
  }

  private submitEffectCommand(
    effect: DurableEffect,
    command: InternalCommand,
  ): Promise<RunSnapshot> {
    return this.schedule(command.runId, () =>
      this.processCommandWithFence(command, {
        effectId: effect.effectId,
        leaseOwner: this.reactorOwner,
        now: this.reactorNow(),
      }),
    ).then((receipt) => receipt.snapshot);
  }

  private async processCommandWithFence(
    command: Command,
    effectFence?: {
      readonly effectId: string;
      readonly leaseOwner: string;
      readonly now?: number;
    },
  ): Promise<CommandReceipt> {
    const appendResult = transactCommand(this.db, {
      runId: command.runId,
      commandId: command.commandId,
      occurredAt: command.issuedAt,
      expectedStreamVersion: command.expectedStreamVersion,
      receipt: receiptDraftFor(command),
      effectFence,
      decide: (snapshot) => {
        const result = decide(snapshot, command);
        return {
          nextSnapshot: result.snapshot ?? snapshot,
          events: result.events,
          effects: createEffectDrafts(command, result.effects),
          effectCancellations: result.effectCancellations,
        };
      },
    });

    if (!appendResult.ok) {
      if (appendResult.reason === "duplicate_command") {
        if (!appendResult.duplicateReceipt) {
          throw new Error(
            `Duplicate command has no durable receipt: ${command.commandId}`,
          );
        }
        return appendResult.duplicateReceipt;
      }
      if (appendResult.reason === "effect_lease_lost") {
        throw new EffectLeaseLostError(
          effectFence?.effectId ?? "unknown",
          "result persistence",
        );
      }
      throw new Error(`Append failed: ${appendResult.reason}`);
    }

    return appendResult.receipt;
  }

  private schedule(
    runId: string,
    execute: () => Promise<CommandReceipt>,
  ): Promise<CommandReceipt> {
    if (this.closed) {
      return Promise.reject(new Error("Orchestration engine is closed"));
    }
    return new Promise<CommandReceipt>((resolve, reject) => {
      const queue = this.runQueues.get(runId) ?? [];
      queue.push({ execute, resolve, reject });
      this.runQueues.set(runId, queue);

      if (!this.activeRuns.has(runId) && !this.queuedRuns.has(runId)) {
        this.queuedRuns.add(runId);
        this.readyRuns.push(runId);
      }
      this.pump();
    });
  }

  private pump(): void {
    while (
      this.activeRuns.size < this.config.maxConcurrentRuns &&
      this.readyRuns.length > 0
    ) {
      const runId = this.readyRuns.shift();
      if (!runId) continue;
      this.queuedRuns.delete(runId);
      const queue = this.runQueues.get(runId);
      const task = queue?.shift();
      if (!queue || !task) {
        this.runQueues.delete(runId);
        continue;
      }

      this.activeRuns.add(runId);
      const running = this.runScheduledTask(runId, task);
      this.activeTasks.add(running);
      void running.finally(() => {
        this.activeTasks.delete(running);
      });
    }
  }

  private async runScheduledTask(
    runId: string,
    task: ScheduledTask,
  ): Promise<void> {
    try {
      task.resolve(await task.execute());
    } catch (error) {
      task.reject(error);
    } finally {
      this.activeRuns.delete(runId);
      const queue = this.runQueues.get(runId);
      if (!this.closed && queue && queue.length > 0) {
        this.queuedRuns.add(runId);
        this.readyRuns.push(runId);
      } else {
        this.runQueues.delete(runId);
      }
      queueMicrotask(() => this.pump());
    }
  }

  private reactorNow(): number {
    return this.config.reactorNow?.() ?? Date.now();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const closedError = new Error("Orchestration engine is closed");
    for (const controller of this.activeReactorControllers) {
      controller.abort(closedError);
    }
    for (const queue of this.runQueues.values()) {
      for (const task of queue) task.reject(closedError);
    }
    this.runQueues.clear();
    this.readyRuns.length = 0;
    this.queuedRuns.clear();

    const activeDrain = this.activeDrain;
    this.closePromise = Promise.allSettled([
      ...this.activeTasks,
      ...(activeDrain ? [activeDrain] : []),
    ]).then(() => undefined);
    return this.closePromise;
  }

  private armNextRetry(): void {
    if (this.closed || this.config.reactorNow !== undefined) return;
    const nextAttemptAt = getNextEffectClaimAt(this.db);
    if (nextAttemptAt === undefined) return;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    const delay = Math.max(0, nextAttemptAt - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.drainEffects().catch(() => {
        this.armNextRetry();
      });
    }, delay);
    const timer = this.retryTimer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timer.unref?.();
  }

}

type ScheduledTask = {
  readonly execute: () => Promise<CommandReceipt>;
  readonly resolve: (receipt: CommandReceipt) => void;
  readonly reject: (error: unknown) => void;
};

function receiptDraftFor(command: Command): CommandReceiptDraft {
  return command.type === "turn.send"
    ? { kind: "turn", turnId: command.payload.turnId }
    : { kind: "snapshot" };
}

function createReceipt(command: Command, snapshot: RunSnapshot): CommandReceipt {
  const draft = receiptDraftFor(command);
  return draft.kind === "turn"
    ? {
        schemaVersion: 1,
        kind: "turn",
        commandId: command.commandId,
        runId: command.runId,
        turnId: draft.turnId,
        snapshot,
      }
    : {
        schemaVersion: 1,
        kind: "snapshot",
        commandId: command.commandId,
        runId: command.runId,
        snapshot,
      };
}

function createEffectDrafts(
  command: Command,
  effects: ReadonlyArray<EffectIntent>,
) {
  return effects.map((intent, effectIndex) => ({
    effectId: `effect-${command.commandId}-${effectIndex}` as never,
    runId: command.runId,
    commandId: command.commandId,
    effectIndex,
    intent,
    retryClass: retryClassFor(intent),
  }));
}

function retryClassFor(intent: EffectIntent): EffectRetryClass {
  switch (intent.kind) {
    case "tool.execute":
      return "never";
    case "provider.start_session":
    case "provider.resume_session":
    case "provider.send_turn":
    case "provider.steer_turn":
    case "provider.interrupt_turn":
    case "provider.resolve_approval":
    case "provider.stop_session":
    case "workspace.create":
    case "workspace.reconcile":
    case "checkpoint.capture":
    case "checkpoint.restore":
    case "projection.publish":
    case "workflow.create_child":
    case "workflow.complete_child":
      return "transient";
  }
}

function toInternalCommand(
  effect: DurableEffect,
  draft: ReactorCommandDraft,
): InternalCommand {
  const envelope = {
    schemaVersion: 1 as const,
    commandId: resultCommandId(effect, draft) as never,
    runId: effect.runId,
    correlationId: `corr-${effect.effectId}` as never,
    causationId: effect.commandId as never,
    actor: { kind: "system" as const, id: "reactor" },
    issuedAt: Date.now(),
  };
  switch (draft.type) {
    case "provider.event":
      return { ...envelope, type: draft.type, payload: draft.payload };
    case "workspace.result":
      return { ...envelope, type: draft.type, payload: draft.payload };
    case "checkpoint.result":
      return { ...envelope, type: draft.type, payload: draft.payload };
  }
}

function resultCommandId(
  effect: DurableEffect,
  draft: ReactorCommandDraft,
): string {
  switch (draft.type) {
    case "provider.event":
      return `cmd-result-${effect.effectId}-provider-${draft.payload.normalizedEvent.eventId}`;
    case "workspace.result":
      return `cmd-result-${effect.effectId}-workspace`;
    case "checkpoint.result":
      return `cmd-result-${effect.effectId}-checkpoint-${draft.payload.checkpointId}`;
  }
}

function toEffectFailureCommand(
  effect: DurableEffect,
  error: string,
): InternalCommand {
  return {
    schemaVersion: 1,
    commandId: `cmd-result-${effect.effectId}-failure` as never,
    type: "effect.result",
    runId: effect.runId,
    correlationId: `corr-${effect.effectId}` as never,
    causationId: effect.commandId as never,
    actor: { kind: "system", id: "reactor" },
    issuedAt: Date.now(),
    payload: {
      effectId: effect.effectId,
      effectKind: effect.intent.kind,
      status: "failed",
      error,
      ...(effect.intent.kind === "provider.send_turn"
        ? { turnId: effect.intent.turnId }
        : {}),
    },
  };
}

function toEffectSuccessCommand(effect: DurableEffect): InternalCommand {
  return {
    schemaVersion: 1,
    commandId: `cmd-result-${effect.effectId}-success` as never,
    type: "effect.result",
    runId: effect.runId,
    correlationId: `corr-${effect.effectId}` as never,
    causationId: effect.commandId as never,
    actor: { kind: "system", id: "reactor" },
    issuedAt: Date.now(),
    payload: {
      effectId: effect.effectId,
      effectKind: effect.intent.kind,
      status: "completed",
      ...(effect.intent.kind === "provider.send_turn"
        ? { turnId: effect.intent.turnId }
        : effect.intent.kind === "provider.resolve_approval"
          ? {
              approvalId: effect.intent.approvalId,
              resolution: effect.intent.resolution,
              ...(effect.intent.turnId === undefined
                ? {}
                : { turnId: effect.intent.turnId }),
            }
          : {}),
    },
  };
}

function assertReactorResult(
  effect: DurableEffect,
  commands: ReadonlyArray<ReactorCommandDraft>,
): void {
  if (effect.intent.kind === "checkpoint.restore") {
    const [result] = commands;
    if (
      commands.length !== 1 ||
      result?.type !== "checkpoint.result" ||
      result.payload.checkpointId !== effect.intent.checkpointId
    ) {
      throw new Error(
        `checkpoint.restore reactor must return exactly one matching checkpoint.result for ${effect.intent.checkpointId}`,
      );
    }
    return;
  }

  if (
    effect.intent.kind === "workspace.create" ||
    effect.intent.kind === "workspace.reconcile"
  ) {
    if (commands.length !== 1 || commands[0]?.type !== "workspace.result") {
      throw new Error(
        `${effect.intent.kind} reactor must return exactly one workspace.result`,
      );
    }
    return;
  }

  if (effect.intent.kind !== "provider.send_turn") return;
  const turnId = effect.intent.turnId;
  const hasForeignResult = commands.some(
    (command) =>
      command.type !== "provider.event" ||
      command.payload.normalizedEvent.turnId !== turnId,
  );
  if (hasForeignResult) {
    throw new Error(
      `provider.send_turn reactor returned a result outside turn ${turnId}`,
    );
  }

  const terminalIndexes = commands.flatMap((command, index) =>
    command.type === "provider.event" &&
    (command.payload.normalizedEvent.type === "turn.completed" ||
      command.payload.normalizedEvent.type === "turn.failed" ||
      command.payload.normalizedEvent.type === "turn.interrupted")
      ? [index]
      : [],
  );
  if (
    terminalIndexes.length > 1 ||
    (terminalIndexes.length === 1 &&
      terminalIndexes[0] !== commands.length - 1)
  ) {
    throw new Error(
      "provider.send_turn reactor may include at most one matching terminal turn event, and it must be last",
    );
  }
}

function assertEffectPostcondition(
  _effect: DurableEffect,
  _snapshot: RunSnapshot | undefined,
): void {
  // Successful execution means the adapter durably accepted the operation.
  // Provider notifications can arrive later through provider.event.
}

function classifyReactorFailure(
  effect: DurableEffect,
  error: unknown,
): ReactorFailureOptions {
  if (error instanceof ReactorFailure) {
    return {
      kind: error.kind,
      message: error.message,
      ...(error.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: error.retryAfterMs }),
    };
  }
  return {
    kind:
      effect.retryClass === "never"
        ? "terminal"
        : effect.retryClass === "rate_limited"
          ? "rate_limited"
          : "retryable",
    message: error instanceof Error ? error.message : String(error),
  };
}

function retryDelayMs(
  effect: DurableEffect,
  failure: ReactorFailureOptions,
  config: EngineConfig,
): number {
  if (
    failure.kind === "rate_limited" &&
    failure.retryAfterMs !== undefined
  ) {
    return Math.max(0, failure.retryAfterMs);
  }
  const base = config.reactorRetryBaseMs ?? 1_000;
  const maximum = config.reactorRetryMaxMs ?? 30_000;
  const exponential = Math.min(
    maximum,
    base * 2 ** Math.max(0, effect.attempts - 1),
  );
  const jitterRatio = config.reactorRetryJitterRatio ?? 0.2;
  return Math.min(
    maximum,
    Math.round(
      exponential +
        exponential *
          jitterRatio *
          stableJitter(effect.effectId, effect.attempts),
    ),
  );
}

function stableJitter(effectId: string, attempts: number): number {
  let hash = attempts;
  for (let index = 0; index < effectId.length; index++) {
    hash = Math.imul(hash ^ effectId.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0) / 0xffff_ffff;
}

function formatEffectFailure(
  effect: DurableEffect,
  failure: ReactorFailureOptions,
): string {
  return `${effect.intent.kind} ${failure.kind} failure after ${effect.attempts} attempt(s): ${failure.message}`;
}

function assertNonNegativeFinite(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}
