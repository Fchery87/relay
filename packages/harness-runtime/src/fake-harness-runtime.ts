const randomUUIDv7 = () => crypto.randomUUID();
import type { RunSnapshot, CanonicalEventType, EventEnvelope, RunStatus } from "@relay/contracts";
import type { CommandId } from "@relay/contracts";

/** Mutable version of RunSnapshot for internal use. */
type MutableRun = {
  -readonly [K in keyof RunSnapshot]: RunSnapshot[K];
};
import type {
  HarnessRuntime,
  CreateRunInput,
  ResumeRunInput,
  SendTurnInput,
  SteerTurnInput,
  InterruptTurnInput,
  ResolveApprovalInput,
  StopRunInput,
  SnapshotInput,
  ObserveInput,
  TurnReceipt,
  AppendEventInput,
  AppendEventResult,
} from "./harness-runtime";

// ---------------------------------------------------------------------------
// Scriptable scenario
// ---------------------------------------------------------------------------

/** A pre-scripted event the fake will emit in order. */
export type ScriptedEvent = {
  /** If provided, only emit after this many operations (calls to the runtime). */
  readonly afterOpCount?: number;
  readonly type: CanonicalEventType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly payload?: Record<string, any>;
};

export type FakeScenario = {
  readonly scriptedEvents: readonly ScriptedEvent[];
  /** If true, `sendTurn` throws a provider-failure error. */
  readonly providerFails?: boolean;
  /** If true, the fake blocks until `drain()` is called. */
  readonly blockOnSend?: boolean;
};

// ---------------------------------------------------------------------------
// Deterministic fake HarnessRuntime
// ---------------------------------------------------------------------------

export class FakeHarnessRuntime implements HarnessRuntime {
  private runs = new Map<
    string,
    {
      snapshot: MutableRun;
      events: Array<EventEnvelope<CanonicalEventType, unknown>>;
      listeners: Array<(event: EventEnvelope<CanonicalEventType, unknown>) => void>;
      blocked: boolean;
    }
  >();
  private opCount = 0;

  constructor(private readonly scenario?: FakeScenario) {}

  // -- public API ------------------------------------------------------------

  async createRun(input: CreateRunInput): Promise<RunSnapshot> {
    this.opCount++;
    const runId = `run-${randomUUIDv7()}` as never;
    const snapshot: MutableRun = {
      runId,
      status: "created",
      sequence: 0,
      streamVersion: 0,
      restartCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.runs.set(runId, {
      snapshot,
      events: [],
      listeners: [],
      blocked: false,
    });
    const created = this.makeEvent("run.created", snapshot, {
      environmentId: "fake-env",
      projectId: input.projectId,
    });
    this.append(snapshot, created);
    // Transition to ready
    return this.transition(snapshot, "ready");
  }

  async resumeRun(input: ResumeRunInput): Promise<RunSnapshot> {
    const run = this.mustGetRun(input.runId);
    // Emit a run.started to move from ready → running
    return this.transition(run.snapshot, "running");
  }

  async sendTurn(input: SendTurnInput): Promise<TurnReceipt> {
    this.opCount++;
    const run = this.mustGetRun(input.runId);

    if (this.scenario?.providerFails) {
      const failed = this.makeEvent("turn.failed", run.snapshot, { error: "provider failure" });
      this.append(run.snapshot, failed);
      throw new Error("Provider process lost");
    }

    if (this.scenario?.blockOnSend) {
      run.blocked = true;
    }

    const turnId = `turn-${randomUUIDv7()}` as never;
    const started = this.makeEvent("turn.started", run.snapshot, { prompt: input.prompt });
    this.append(run.snapshot, started);

    // Play scripted events
    if (this.scenario) {
      for (const se of this.scenario.scriptedEvents) {
        if (se.afterOpCount !== undefined && se.afterOpCount > this.opCount) continue;
        const ev = this.makeEvent(se.type, run.snapshot, se.payload ?? {});
        this.append(run.snapshot, ev);
      }
    }

    // Emit assistant response
    const delta = this.makeEvent("assistant.delta", run.snapshot, { text: "fake reply" });
    this.append(run.snapshot, delta);
    const completed = this.makeEvent("assistant.completed", run.snapshot, {});
    this.append(run.snapshot, completed);
    const turnDone = this.makeEvent("turn.completed", run.snapshot, {});
    this.append(run.snapshot, turnDone);

    // Transition to completed (simulated one-turn run)
    this.transition(run.snapshot, "completed");

    const commandId = `cmd-${randomUUIDv7()}` as CommandId;
    return { turnId: turnId as never, commandId };
  }

  async steerTurn(input: SteerTurnInput): Promise<void> {
    const run = this.mustGetRun(input.runId);
    const ev = this.makeEvent("turn.steered", run.snapshot, { steering: input.steering });
    this.append(run.snapshot, ev);
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    const run = this.mustGetRun(input.runId);
    const ev = this.makeEvent("turn.interrupted", run.snapshot, {
      reason: input.reason ?? "user",
    });
    this.append(run.snapshot, ev);
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<void> {
    const run = this.mustGetRun(input.runId);
    const ev = this.makeEvent("approval.resolved", run.snapshot, {
      approvalId: input.approvalId,
      resolution: input.resolution,
    });
    this.append(run.snapshot, ev);
  }

  async stopRun(input: StopRunInput): Promise<void> {
    const run = this.mustGetRun(input.runId);
    const stopping = this.makeEvent("run.stopping", run.snapshot, {
      reason: input.reason ?? "user",
    });
    this.transition(run.snapshot, "stopping");
    this.append(run.snapshot, stopping);
    const stopped = this.makeEvent("run.stopped", run.snapshot, {});
    this.append(run.snapshot, stopped);
    this.transition(run.snapshot, "stopped");
  }

  async snapshot(input: SnapshotInput): Promise<RunSnapshot> {
    return this.mustGetRun(input.runId).snapshot;
  }

  async *observe(input: ObserveInput): AsyncIterable<EventEnvelope<CanonicalEventType, unknown>> {
    const run = this.mustGetRun(input.runId);
    const after = input.afterSequence ?? -1;

    // Replay already-emitted events
    for (const ev of run.events) {
      if (ev.sequence > after) yield ev;
    }

    // If run is still active, stay open for future events via a push listener.
    // For simplicity in the fake, we yield what we have and close.
    if (run.snapshot.status === "stopped" || run.snapshot.status === "completed" || run.snapshot.status === "failed") {
      return;
    }

    // Yield remaining scripted events (already appended by sendTurn).
    for (const ev of run.events) {
      if (ev.sequence > after) yield ev;
    }
  }

  // -- control surface for tests ---------------------------------------------

  async appendEvent(
    runId: string,
    input: AppendEventInput,
  ): Promise<AppendEventResult> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, reason: `Run not found: ${runId}` };
    const ev = this.makeEvent(input.type, run.snapshot, input.payload);
    this.append(run.snapshot, ev);
    return { ok: true, sequence: run.snapshot.sequence };
  }

  listRuns(): ReadonlyArray<{ runId: string; status: string }> {
    return Array.from(this.runs.entries()).map(([id, r]) => ({
      runId: id,
      status: r.snapshot.status,
    }));
  }

  /** Complete all blocked operations. */
  drain(): void {
    for (const [, run] of this.runs) {
      run.blocked = false;
    }
  }

  // -- internals -------------------------------------------------------------

  private makeEvent<T>(type: CanonicalEventType, snapshot: MutableRun, payload: T): EventEnvelope<CanonicalEventType, T> {
    return {
      eventId: `ev-${randomUUIDv7()}` as never,
      sequence: snapshot.sequence + 1,
      streamVersion: snapshot.streamVersion + 1,
      type,
      runId: snapshot.runId,
      correlationId: `corr-${randomUUIDv7()}` as never,
      occurredAt: Date.now(),
      payload,
    };
  }

  private append(snapshot: MutableRun, event: EventEnvelope<CanonicalEventType, unknown>): void {
    const run = this.runs.get(snapshot.runId);
    if (!run) return;
    const sequence = snapshot.sequence + 1;
    const streamVersion = snapshot.streamVersion + 1;
    const ev = { ...event, sequence, streamVersion };
    run.events.push(ev);
    snapshot.sequence = sequence;
    snapshot.streamVersion = streamVersion;
    for (const listener of run.listeners) {
      try { listener(ev); } catch { /* swallow */ }
    }
  }

  private transition(snapshot: MutableRun, target: RunStatus): RunSnapshot {
    snapshot.status = target;
    snapshot.updatedAt = Date.now();
    return snapshot;
  }

  private mustGetRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }
}
