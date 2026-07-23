import type { RunSnapshot, EventEnvelope, CanonicalEventType } from "@relay/contracts";
import type { RunId } from "@relay/contracts";
import { reduceVisibleRun } from "./event-reducer";

// ---------------------------------------------------------------------------
// Client runtime — snapshot+sequence state, ordered delta application,
// cursor-based resume, command submission.
// ---------------------------------------------------------------------------

export type ClientState = {
  readonly runId: RunId;
  snapshot?: RunSnapshot;
  cursor: number;
  terminal: boolean;
  connected: boolean;
  fresh: boolean;
  lastError?: string;
};

export type ClientConfig = {
  /** Fetch a snapshot for a run (e.g. from Convex or local store). */
  fetchSnapshot(runId: string): Promise<RunSnapshot | undefined>;
  /** Fetch events after a given sequence. */
  fetchEvents(
    runId: string,
    afterSequence: number,
  ): Promise<Array<EventEnvelope<CanonicalEventType, unknown>>>;
  /** Submit a command. Returns the resulting snapshot. */
  submitCommand(command: {
    commandId: string;
    kind: string;
    runId: string;
    payload: Record<string, unknown>;
  }): Promise<RunSnapshot>;
  /** Called when a new event is applied. */
  onEvent?(event: EventEnvelope<CanonicalEventType, unknown>): void;
  /** Called when the state reaches a terminal status. */
  onTerminal?(status: string): void;
  /** Optional durable cursor sink, called only after an event is applied. */
  cursorStore?: {
    load(runId: string): number | null | undefined;
    save(runId: string, sequence: number): void;
  };
};

export class ClientRuntime {
  private state: Map<string, ClientState> = new Map();

  constructor(private readonly config: ClientConfig) {}

  /** Connect to a run: fetch snapshot, then apply pending events. */
  async connect(runId: string): Promise<ClientState> {
    const snapshot = await this.config.fetchSnapshot(runId);
    if (!snapshot) {
      throw new Error(`Run not found: ${runId}`);
    }
    const confirmedCursor = this.config.cursorStore?.load(runId);
    if (confirmedCursor !== null && confirmedCursor !== undefined && confirmedCursor > snapshot.sequence) {
      throw new Error(`Projection snapshot is behind confirmed cursor for run ${runId}: ${snapshot.sequence} < ${confirmedCursor}`);
    }

    const state: ClientState = {
      runId: snapshot.runId,
      snapshot,
      cursor: snapshot.sequence,
      terminal: isTerminal(snapshot.status),
      connected: true,
      fresh: true,
    };

    this.state.set(runId, state);
    this.config.cursorStore?.save(runId, state.cursor);

    // Apply events after the snapshot
    await this.catchUp(runId);

    return state;
  }

  /** Resume from the last cursor: fetch and apply new events only. */
  async resume(runId: string): Promise<ClientState> {
    const existing = this.state.get(runId);
    if (!existing) return this.connect(runId);
    await this.catchUp(runId);
    return existing;
  }

  /** Submit a command and update state from the resulting snapshot. */
  async submit(runId: string, kind: string, payload: Record<string, unknown> = {}): Promise<ClientState> {
    const commandId = `${runId}:${kind}:${stablePayloadId(payload)}`;
    const snapshot = await this.config.submitCommand({ commandId, kind, runId, payload });
    const state = this.state.get(runId);
    if (state && snapshot.sequence < state.cursor) {
      throw new Error(`Projection snapshot regressed for run ${runId}: ${snapshot.sequence} < ${state.cursor}`);
    }
    const updated: ClientState = {
      runId: snapshot.runId,
      snapshot,
      cursor: Math.max(state?.cursor ?? 0, snapshot.sequence),
      terminal: isTerminal(snapshot.status),
      connected: true,
      fresh: true,
    };
    this.state.set(runId, updated);
    this.config.cursorStore?.save(runId, updated.cursor);
    await this.catchUp(runId);
    return updated;
  }

  /** Get the current state for a run. */
  get(runId: string): ClientState | undefined {
    return this.state.get(runId);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async catchUp(runId: string): Promise<void> {
    const state = this.state.get(runId);
    if (!state) return;

    // Fetch events after the cursor
    let events: Array<EventEnvelope<CanonicalEventType, unknown>>;
    try { events = await this.config.fetchEvents(runId, state.cursor); state.connected = true; state.lastError = undefined; }
    catch (error) { state.connected = false; state.fresh = false; state.lastError = error instanceof Error ? error.message : String(error); throw error; }

    try {
      const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
      for (const ev of orderedEvents) {
        if (ev.sequence <= state.cursor) continue; // already applied
        if (ev.sequence !== state.cursor + 1) {
          throw new Error(`Projection gap for run ${runId}: expected sequence ${state.cursor + 1}, received ${ev.sequence}`);
        }
        state.snapshot = state.snapshot ? reduceVisibleRun(state.snapshot, ev) : state.snapshot;
        if (this.config.onEvent) this.config.onEvent(ev);
        state.cursor = ev.sequence;
        this.config.cursorStore?.save(runId, state.cursor);

        // A completed turn is not the same as a completed run.
        if (ev.type === "run.stopped" || ev.type === "run.failed") {
          state.terminal = true;
          if (this.config.onTerminal) this.config.onTerminal(ev.type);
        }
      }
      state.fresh = true;
      this.state.set(runId, state);
    } catch (error) {
      state.connected = false;
      state.fresh = false;
      state.lastError = error instanceof Error ? error.message : String(error);
      this.state.set(runId, state);
      throw error;
    }
  }
}

function stablePayloadId(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload, Object.keys(payload).sort());
  let hash = 2166136261;
  for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

function isTerminal(status: string): boolean {
  return status === "stopped" || status === "completed" || status === "failed";
}
