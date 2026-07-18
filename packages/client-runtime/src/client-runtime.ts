import type { RunSnapshot, EventEnvelope, CanonicalEventType } from "@relay/contracts";
import type { RunId } from "@relay/contracts";

// ---------------------------------------------------------------------------
// Client runtime — snapshot+sequence state, ordered delta application,
// cursor-based resume, command submission.
// ---------------------------------------------------------------------------

export type ClientState = {
  readonly runId: RunId;
  readonly snapshot?: RunSnapshot;
  /** The last applied sequence (exclusive). */
  cursor: number;
  /** Whether the run has reached a terminal status. */
  terminal: boolean;
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
    kind: string;
    runId: string;
    payload: Record<string, unknown>;
  }): Promise<RunSnapshot>;
  /** Called when a new event is applied. */
  onEvent?(event: EventEnvelope<CanonicalEventType, unknown>): void;
  /** Called when the state reaches a terminal status. */
  onTerminal?(status: string): void;
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

    const state: ClientState = {
      runId: snapshot.runId,
      snapshot,
      cursor: snapshot.sequence,
      terminal: isTerminal(snapshot.status),
    };

    this.state.set(runId, state);

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
    const snapshot = await this.config.submitCommand({ kind, runId, payload });
    const state = this.state.get(runId);
    const updated: ClientState = {
      runId: snapshot.runId,
      snapshot,
      cursor: Math.max(state?.cursor ?? 0, snapshot.sequence),
      terminal: isTerminal(snapshot.status),
    };
    this.state.set(runId, updated);
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
    const events = await this.config.fetchEvents(runId, state.cursor);

    const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
    for (const ev of orderedEvents) {
      if (ev.sequence <= state.cursor) continue; // already applied
      if (ev.sequence !== state.cursor + 1) {
        throw new Error(`Projection gap for run ${runId}: expected sequence ${state.cursor + 1}, received ${ev.sequence}`);
      }
      state.cursor = ev.sequence;
      if (this.config.onEvent) this.config.onEvent(ev);

      // A completed turn is not the same as a completed run.
      if (ev.type === "run.stopped" || ev.type === "run.failed") {
        state.terminal = true;
        if (this.config.onTerminal) this.config.onTerminal(ev.type);
      }
    }

    this.state.set(runId, state);
  }
}

function isTerminal(status: string): boolean {
  return status === "stopped" || status === "completed" || status === "failed";
}
