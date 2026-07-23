import type { ProjectionSink } from "./convex-projection-sink";

// ---------------------------------------------------------------------------
// Fake projection sink — an in-memory stand-in for the real Convex mutations
// in convex/projections/publish.ts, mirroring their idempotency and
// gap-rejection contracts, for deterministic fault-injection tests without a
// live backend. Not for production use.
// ---------------------------------------------------------------------------

export type FakeProjectionSinkEvent = {
  eventId: string;
  occurredAt: number;
  payloadJson: string;
  projectId: string;
  runId: string;
  sequence: number;
  type: string;
};

export type FakeProjectionSinkOptions = {
  /**
   * Called before each `appendEvents` call resolves. Return an Error to make
   * the call reject (simulating a lost response, backend restart, or
   * network partition) without mutating durable state — mirrors a Convex
   * mutation that never committed, or whose response never arrived.
   */
  failAppendEvents?: () => Error | undefined;
};

export function createFakeProjectionSink(
  options: FakeProjectionSinkOptions = {},
): ProjectionSink & {
  readonly events: ReadonlyArray<FakeProjectionSinkEvent>;
  readonly appendEventsCallCount: number;
  readonly cursors: ReadonlyMap<string, number>;
} {
  const events: FakeProjectionSinkEvent[] = [];
  const bySequenceKey = new Map<string, FakeProjectionSinkEvent>();
  const cursors = new Map<string, number>();
  let appendEventsCallCount = 0;

  return {
    get events() {
      return events;
    },
    get appendEventsCallCount() {
      return appendEventsCallCount;
    },
    get cursors() {
      return cursors;
    },
    async appendEvents(input) {
      appendEventsCallCount++;
      const failure = options.failAppendEvents?.();
      if (failure) throw failure;

      // Mirror the real mutation: a single sequential pass where each event
      // sees prior events from the same batch already committed — matching
      // Convex's within-transaction read-your-writes semantics. The whole
      // call still fails atomically (before this loop starts) when
      // `failAppendEvents` injects a failure, so nothing here is observed.
      for (const ev of input.events) {
        const key = `${ev.runId}:${ev.sequence}`;
        const existing = bySequenceKey.get(key);
        if (existing) {
          const identical =
            existing.eventId === ev.eventId &&
            existing.payloadJson === ev.payloadJson &&
            existing.type === ev.type &&
            existing.occurredAt === ev.occurredAt;
          if (!identical) throw new Error(`Conflicting duplicate projection event for ${key}`);
          continue;
        }
        const previous = bySequenceKey.get(`${ev.runId}:${ev.sequence - 1}`);
        if (ev.sequence > 1 && !previous) throw new Error(`Gap in projection sequence for ${key}`);
        const record = { ...ev };
        bySequenceKey.set(key, record);
        events.push(record);
      }
    },
    async upsertSnapshot() {
      // Snapshot persistence isn't exercised by outbox fault-injection tests.
    },
    async advanceCursor(input) {
      const key = `${input.machineId}:${input.direction}`;
      const existing = cursors.get(key) ?? 0;
      if (input.sequence < existing) throw new Error(`Cursor regression for ${key}`);
      cursors.set(key, input.sequence);
    },
  };
}
