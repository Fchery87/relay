import type {
  CommandReceipt,
  CommandReceiptDraft,
  CreateRunCommand,
  DurableEffect,
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
};

// ---------------------------------------------------------------------------
// Engine — serializes transitions per run, bounds global concurrency.
// ---------------------------------------------------------------------------

export class OrchestrationEngine {
  private readonly activeRuns = new Set<string>();
  private readonly queuedRuns = new Set<string>();
  private readonly readyRuns: string[] = [];
  private readonly runQueues = new Map<string, ScheduledTask[]>();
  private readonly reactorOwner = `reactor-${crypto.randomUUID()}`;
  private activeDrain?: Promise<number>;

  constructor(
    private readonly db: StoreDatabase,
    private readonly config: EngineConfig,
  ) {
    if (!Number.isInteger(config.maxConcurrentRuns) || config.maxConcurrentRuns < 1) {
      throw new Error("maxConcurrentRuns must be a positive integer");
    }
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
    const previous = this.activeDrain;
    const pass = previous
      ? previous.then(
          () => this.performDrain(),
          () => this.performDrain(),
        )
      : this.performDrain();
    const drain = pass.finally(() => {
      if (this.activeDrain === drain) this.activeDrain = undefined;
    });
    this.activeDrain = drain;
    return drain;
  }

  private async performDrain(): Promise<number> {
    let completed = 0;
    const batchSize = this.config.reactorBatchSize ?? 32;

    for (let claimed = 0; claimed < batchSize; claimed++) {
      // Claim immediately before execution so later effects never spend this
      // effect's runtime burning down their own leases.
      const [effect] = claimEffectBatch(
        this.db,
        this.reactorOwner,
        this.config.reactorLeaseMs ?? 30_000,
        1,
      );
      if (!effect) break;
      if (effect.recoveryFailure) {
        await this.submitEffectCommand(
          effect,
          toEffectFailureCommand(effect, effect.recoveryFailure),
        );
        releaseEffect(
          this.db,
          effect.effectId,
          this.reactorOwner,
          effect.recoveryFailure,
          true,
        );
        continue;
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
          effect.effectId,
          this.reactorOwner,
          message,
          true,
        );
        continue;
      }

      const leaseMs = this.config.reactorLeaseMs ?? 30_000;
      const controller = new AbortController();
      let leaseFailure: Error | undefined;
      const renewal = setInterval(() => {
        try {
          if (
            !renewEffectLease(
              this.db,
              effect.effectId,
              this.reactorOwner,
              leaseMs,
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
          )
        ) {
          throw new EffectLeaseLostError(effect.effectId, "result persistence");
        }
        assertTerminalReactorResult(effect, commands);
        let resultSnapshot: RunSnapshot | undefined;
        for (const command of commands) {
          resultSnapshot = await this.submitEffectCommand(
            effect,
            toInternalCommand(effect, command),
          );
        }
        assertEffectPostcondition(effect, resultSnapshot);
        completeEffect(this.db, effect.effectId, this.reactorOwner);
        completed++;
      } catch (error) {
        if (leaseFailure || error instanceof EffectLeaseLostError) continue;
        const message = error instanceof Error ? error.message : String(error);
        const terminal =
          effect.retryClass === "never" ||
          effect.attempts >= (this.config.reactorMaxAttempts ?? 5);
        if (terminal) {
          try {
            await this.submitEffectCommand(
              effect,
              toEffectFailureCommand(effect, message),
            );
          } catch (resultError) {
            fenceEffectForFailureRecovery(
              this.db,
              effect.effectId,
              this.reactorOwner,
              message,
            );
            throw resultError;
          }
        }
        releaseEffect(
          this.db,
          effect.effectId,
          this.reactorOwner,
          message,
          terminal,
        );
      } finally {
        clearInterval(renewal);
      }
    }

    return completed;
  }

  // -- creation helpers -------------------------------------------------------

  async createRun(input: {
    readonly projectId: string;
    readonly permissionProfile?: "read-only" | "workspace-write" | "full-access";
  }): Promise<RunSnapshot> {
    const runId = `run-${crypto.randomUUID()}` as never;
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
      expectedStreamVersion: initialSnapshot.streamVersion,
      initialSnapshot,
      receipt: { kind: "snapshot" },
      decide: (snapshot) => {
        const result = decide(snapshot, command);
        return {
          nextSnapshot: result.snapshot ?? snapshot,
          events: result.events,
          effects: createEffectDrafts(command, result.effects),
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
      }),
    ).then((receipt) => receipt.snapshot);
  }

  private async processCommandWithFence(
    command: Command,
    effectFence?: {
      readonly effectId: string;
      readonly leaseOwner: string;
    },
  ): Promise<CommandReceipt> {
    const appendResult = transactCommand(this.db, {
      runId: command.runId,
      commandId: command.commandId,
      expectedStreamVersion: command.expectedStreamVersion,
      receipt: receiptDraftFor(command),
      effectFence,
      decide: (snapshot) => {
        const result = decide(snapshot, command);
        return {
          nextSnapshot: result.snapshot ?? snapshot,
          events: result.events,
          effects: createEffectDrafts(command, result.effects),
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
      void this.runScheduledTask(runId, task);
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
      if (queue && queue.length > 0) {
        this.queuedRuns.add(runId);
        this.readyRuns.push(runId);
      } else {
        this.runQueues.delete(runId);
      }
      queueMicrotask(() => this.pump());
    }
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

function assertTerminalReactorResult(
  effect: DurableEffect,
  commands: ReadonlyArray<ReactorCommandDraft>,
): void {
  if (commands.length === 0) {
    throw new Error(
      `Reactor ${effect.intent.kind} returned no terminal result command`,
    );
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
  const terminalIndex = terminalIndexes[0];
  const terminal =
    terminalIndex === undefined ? undefined : commands[terminalIndex];
  if (
    terminalIndexes.length !== 1 ||
    terminalIndex !== commands.length - 1 ||
    terminal?.type !== "provider.event" ||
    terminal.payload.normalizedEvent.turnId !== turnId
  ) {
    throw new Error(
      "provider.send_turn reactor must end with exactly one matching terminal turn event",
    );
  }
}

function assertEffectPostcondition(
  effect: DurableEffect,
  snapshot: RunSnapshot | undefined,
): void {
  if (
    effect.intent.kind === "provider.send_turn" &&
    snapshot?.activeTurnId !== undefined
  ) {
    throw new Error(
      `provider.send_turn result did not terminate turn ${effect.intent.turnId}`,
    );
  }
}
