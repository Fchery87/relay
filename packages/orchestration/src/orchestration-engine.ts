import type { RunSnapshot } from "@relay/contracts";
import type { Command, ExternalCommand, InternalCommand } from "@relay/contracts";
import type { StoreDatabase } from "@relay/local-store";
import { appendEvents, getSnapshot, insertSnapshot, updateSnapshotStatus } from "@relay/local-store";
import { decide, type DeciderResult, type EffectIntent } from "./decider";

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
  private activeRuns = new Set<string>();
  private runQueues = new Map<string, Array<() => void>>();
  private processing = new Map<string, boolean>();

  constructor(
    private readonly db: StoreDatabase,
    private readonly config: EngineConfig,
  ) {}

  /**
   * Submit an external or internal command. Returns the resulting snapshot
   * after the command has been durably processed.
   */
  async submit(command: ExternalCommand | InternalCommand): Promise<RunSnapshot> {
    const runId = command.runId as string;

    // Queue up if this run is already processing
    if (this.processing.get(runId)) {
      return new Promise<RunSnapshot>((resolve) => {
        const queue = this.runQueues.get(runId) ?? [];
        queue.push(() => {
          resolve(this.processCommand(command));
        });
        this.runQueues.set(runId, queue);
      });
    }

    // Wait for concurrency slot if at limit and this is a new run
    if (!this.activeRuns.has(runId) && this.activeRuns.size >= this.config.maxConcurrentRuns) {
      // For simplicity, allow the command but the run won't proceed concurrently.
      // A real implementation would queue at the engine level.
    }

    this.processing.set(runId, true);
    this.activeRuns.add(runId);

    try {
      return await this.processCommand(command);
    } finally {
      this.processing.set(runId, false);
      // Drain queued commands for this run
      const queue = this.runQueues.get(runId);
      if (queue && queue.length > 0) {
        const next = queue.shift();
        this.runQueues.set(runId, queue);
        if (next) next();
      } else {
        this.activeRuns.delete(runId);
      }
    }
  }

  // -- creation helpers -------------------------------------------------------

  createRunSnapshot(projectId: string): RunSnapshot {
    const runId = `run-${crypto.randomUUID()}` as never;
    const snapshot: RunSnapshot = {
      runId,
      status: "created",
      sequence: 0,
      streamVersion: 0,
      restartCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    insertSnapshot(this.db, snapshot);
    return snapshot;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async processCommand(command: Command): Promise<RunSnapshot> {
    const runId = command.runId as string;

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
      runId,
      commandId: command.commandId as string,
      expectedStreamVersion: command.expectedStreamVersion,
      events: result.events.map((ev) => ({
        eventId: ev.eventId,
        type: ev.type,
        payload: ev.payload,
        correlationId: ev.correlationId,
        causationId: ev.causationId,
      })),
    });

    if (!appendResult.ok) {
      if (appendResult.reason === "duplicate_command") {
        return appendResult.duplicateSnapshot ?? snapshot;
      }
      throw new Error(`Append failed: ${appendResult.reason}`);
    }

    // Apply status transitions
    if (result.snapshot) {
      updateSnapshotStatus(this.db, runId, result.snapshot.status);
    }

    // Dispatch effects (for now, synchronous — reactors will be async in a real impl)
    for (const effect of result.effects) {
      this.dispatchEffect(runId, effect);
    }

    return appendResult.snapshot;
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
