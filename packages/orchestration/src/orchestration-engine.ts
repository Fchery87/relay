import type { CreateRunCommand, RunSnapshot } from "@relay/contracts";
import type { Command, ExternalCommand, InternalCommand } from "@relay/contracts";
import type { StoreDatabase } from "@relay/local-store";
import {
  appendEvents,
  getCommandReceiptSnapshot,
  getSnapshot,
} from "@relay/local-store";
import { decide, type EffectIntent } from "./decider";

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

export type EngineConfig = {
  /** Maximum concurrent runs. */
  readonly maxConcurrentRuns: number;
};

// ---------------------------------------------------------------------------
// Engine — serializes transitions per run, bounds global concurrency.
// ---------------------------------------------------------------------------

export class OrchestrationEngine {
  private readonly activeRuns = new Set<string>();
  private readonly queuedRuns = new Set<string>();
  private readonly readyRuns: string[] = [];
  private readonly runQueues = new Map<string, ScheduledTask[]>();

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
    const runId = command.runId as string;
    return this.schedule(runId, () => this.processCommand(command));
  }

  // -- creation helpers -------------------------------------------------------

  async createRun(input: {
    readonly projectId: string;
    readonly permissionProfile?: "read-only" | "workspace-write" | "full-access";
  }): Promise<RunSnapshot> {
    const runId = `run-${crypto.randomUUID()}` as never;
    const initialSnapshot: RunSnapshot = {
      runId,
      status: "created",
      sequence: 0,
      streamVersion: 0,
      restartCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const command: CreateRunCommand = {
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
    return this.schedule(runId, () =>
      this.processCreateCommand(initialSnapshot, command),
    );
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async processCreateCommand(
    initialSnapshot: RunSnapshot,
    command: CreateRunCommand,
  ): Promise<RunSnapshot> {
    const result = decide(initialSnapshot, command);
    const appendResult = appendEvents(this.db, {
      runId: command.runId,
      commandId: command.commandId,
      expectedStreamVersion: initialSnapshot.streamVersion,
      initialSnapshot,
      nextSnapshot: result.snapshot ?? initialSnapshot,
      events: result.events,
    });

    if (!appendResult.ok) {
      if (appendResult.reason === "duplicate_command") {
        return appendResult.duplicateSnapshot ?? initialSnapshot;
      }
      throw new Error(`Create run failed: ${appendResult.reason}`);
    }

    return appendResult.snapshot;
  }

  private async processCommand(command: Command): Promise<RunSnapshot> {
    const runId = command.runId as string;

    // Redelivery must return its immutable result before state validation.
    const completed = getCommandReceiptSnapshot(
      this.db,
      command.commandId,
      command.runId,
    );
    if (completed) return completed;

    // Load current snapshot
    const snapshot = getSnapshot(this.db, runId);
    if (!snapshot) {
      throw new Error(`Run not found: ${runId}`);
    }

    // Run the pure decider
    const result = decide(snapshot, command);

    if (result.events.length === 0 && result.effects.length === 0) {
      return snapshot;
    }

    // Persist atomically
    const appendResult = appendEvents(this.db, {
      runId: command.runId,
      commandId: command.commandId,
      expectedStreamVersion:
        command.expectedStreamVersion ?? snapshot.streamVersion,
      nextSnapshot: result.snapshot ?? snapshot,
      events: result.events,
    });

    if (!appendResult.ok) {
      if (appendResult.reason === "duplicate_command") {
        return appendResult.duplicateSnapshot ?? snapshot;
      }
      throw new Error(`Append failed: ${appendResult.reason}`);
    }

    // Dispatch effects (for now, synchronous — reactors will be async in a real impl)
    for (const effect of result.effects) {
      this.dispatchEffect(runId, effect);
    }

    return appendResult.snapshot;
  }

  private schedule(
    runId: string,
    execute: () => Promise<RunSnapshot>,
  ): Promise<RunSnapshot> {
    return new Promise<RunSnapshot>((resolve, reject) => {
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

  private dispatchEffect(runId: string, effect: EffectIntent): void {
    switch (effect.kind) {
      case "provider.send_turn":
      case "provider.start_session":
      case "provider.stop_session":
      case "workspace.create":
      case "checkpoint.capture":
      case "projection.publish":
        // Reactors are stubbed — they emit internal commands back to the engine.
        break;
    }
  }
}

type ScheduledTask = {
  readonly execute: () => Promise<RunSnapshot>;
  readonly resolve: (snapshot: RunSnapshot) => void;
  readonly reject: (error: unknown) => void;
};
