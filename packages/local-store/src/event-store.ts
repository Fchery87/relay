import type { RunSnapshot } from "@relay/contracts";
import type { CanonicalEvent, CanonicalEventType, EventEnvelope } from "@relay/contracts";
import type { StoreDatabase } from "./database";

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export type AppendInput = {
  readonly runId: string;
  readonly commandId: string;
  /** If provided, reject if the current stream version doesn't match. */
  readonly expectedStreamVersion?: number;
  readonly events: ReadonlyArray<{
    readonly eventId: string;
    readonly type: CanonicalEventType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly payload: Record<string, any>;
    readonly correlationId: string;
    readonly causationId?: string;
  }>;
};

export type AppendResult =
  | {
      readonly ok: true;
      readonly snapshot: RunSnapshot;
      readonly events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>;
    }
  | {
      readonly ok: false;
      readonly reason: "duplicate_command" | "version_conflict" | "run_not_found";
      /** If duplicate, the original receipt result. */
      readonly duplicateSnapshot?: RunSnapshot;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Atomically accept a command and produce canonical events.
 *
 * In one transaction (WAL, so readers are never blocked):
 * 1. Look up the command receipt → if duplicate, return the cached result.
 * 2. Load the current snapshot.
 * 3. If expectedStreamVersion is set and doesn't match, reject.
 * 4. Assign sequence numbers, insert event rows, update the snapshot.
 * 5. Insert outbox rows and the command receipt.
 *
 * Rollback on any failure — no partial writes.
 */
export function appendEvents(
  db: StoreDatabase,
  input: AppendInput,
): AppendResult {
  const now = Date.now();

  const result = db.transaction((): AppendResult => {
    // 1. Duplicate check
    const existing = db
      .query("SELECT result_json FROM command_receipts WHERE command_id = ?")
      .get(input.commandId) as { result_json: string | null } | undefined;

    if (existing) {
      // Idempotent: return the cached snapshot from the original receipt.
      if (existing.result_json) {
        try {
          const cached = JSON.parse(existing.result_json) as RunSnapshot;
          return { ok: false, reason: "duplicate_command", duplicateSnapshot: cached };
        } catch { /* fall through to re-read */ }
      }
      const dup = db
        .query("SELECT * FROM run_snapshots WHERE run_id = ?")
        .get(input.runId) as RunSnapshotRow | undefined;

      return {
        ok: false,
        reason: "duplicate_command",
        duplicateSnapshot: dup ? rowToSnapshot(dup) : undefined,
      };
    }

    // 2. Load snapshot
    const row = db
      .query("SELECT * FROM run_snapshots WHERE run_id = ?")
      .get(input.runId) as RunSnapshotRow | undefined;

    if (!row) {
      return { ok: false, reason: "run_not_found" };
    }

    // 3. Optimistic concurrency check
    if (
      input.expectedStreamVersion !== undefined &&
      input.expectedStreamVersion !== row.stream_version
    ) {
      return { ok: false, reason: "version_conflict" };
    }

    // 4. Append events, bump sequence
    let seq = row.sequence;
    let stream = row.stream_version;
    const envelopes: Array<EventEnvelope<CanonicalEventType, unknown>> = [];

    for (const ev of input.events) {
      seq++;
      stream++;
      const envelope: EventEnvelope<CanonicalEventType, unknown> = {
        eventId: ev.eventId as never,
        sequence: seq,
        streamVersion: stream,
        type: ev.type,
        runId: input.runId as never,
        correlationId: ev.correlationId as never,
        causationId: ev.causationId as never,
        occurredAt: now,
        payload: ev.payload,
      };
      envelopes.push(envelope);

      db.run(
        `INSERT INTO run_events (event_id, run_id, sequence, stream_version, type, payload_json, correlation_id, causation_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ev.eventId,
          input.runId,
          seq,
          stream,
          ev.type,
          JSON.stringify(ev.payload),
          ev.correlationId,
          ev.causationId ?? null,
          now,
        ],
      );

      // Outbox row — publish every event
      db.run(
        `INSERT INTO projection_outbox (event_id, run_id, sequence, type, payload_json, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ev.eventId, input.runId, seq, ev.type, JSON.stringify(ev.payload), now, now],
      );
    }

    // Update snapshot
    const payload = snapshotPayload(row, seq, stream);
    db.run(
      `UPDATE run_snapshots SET sequence = ?, stream_version = ?, payload_json = ?, updated_at = ? WHERE run_id = ?`,
      [seq, stream, JSON.stringify(payload), now, input.runId],
    );

    // 5. Command receipt — store the full snapshot so duplicate returns the immutable result
    const finalSnapshot = rowToSnapshot({ ...row, sequence: seq, stream_version: stream, payload_json: JSON.stringify(payload), updated_at: now });
    db.run(
      `INSERT INTO command_receipts (command_id, run_id, completed_at, result_json) VALUES (?, ?, ?, ?)`,
      [input.commandId, input.runId, now, JSON.stringify(finalSnapshot)],
    );

    return {
      ok: true,
      snapshot: finalSnapshot,
      events: envelopes,
    };
  })();

  return result;
}

// ---------------------------------------------------------------------------
// Snapshot CRUD
// ---------------------------------------------------------------------------

export function insertSnapshot(
  db: StoreDatabase,
  snapshot: RunSnapshot,
): void {
  db.run(
    `INSERT INTO run_snapshots (run_id, status, sequence, stream_version, payload_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      snapshot.runId,
      snapshot.status,
      snapshot.sequence,
      snapshot.streamVersion,
      JSON.stringify(snapshot),
      snapshot.updatedAt,
    ],
  );
}

export function getSnapshot(
  db: StoreDatabase,
  runId: string,
): RunSnapshot | undefined {
  const row = db
    .query("SELECT * FROM run_snapshots WHERE run_id = ?")
    .get(runId) as RunSnapshotRow | undefined;
  return row ? rowToSnapshot(row) : undefined;
}

export function updateSnapshotStatus(
  db: StoreDatabase,
  runId: string,
  status: string,
): void {
  db.run(
    `UPDATE run_snapshots SET status = ?, updated_at = ? WHERE run_id = ?`,
    [status, Date.now(), runId],
  );
}

// ---------------------------------------------------------------------------
// Event replay
// ---------------------------------------------------------------------------

export function getEventsAfter(
  db: StoreDatabase,
  runId: string,
  afterSequence: number,
): Array<EventEnvelope<CanonicalEventType, unknown>> {
  const rows = db
    .query(
      `SELECT * FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC`,
    )
    .all(runId, afterSequence) as EventRow[];

  return rows.map(rowToEvent);
}

function rowToEvent(row: EventRow): EventEnvelope<CanonicalEventType, unknown> {
  return {
    eventId: row.event_id as never,
    sequence: row.sequence,
    streamVersion: row.stream_version,
    type: row.type as CanonicalEventType,
    runId: row.run_id as never,
    correlationId: row.correlation_id as never,
    causationId: (row.causation_id ?? undefined) as never,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type RunSnapshotRow = {
  run_id: string;
  status: string;
  sequence: number;
  stream_version: number;
  payload_json: string;
  updated_at: number;
};

type EventRow = {
  event_id: string;
  run_id: string;
  sequence: number;
  stream_version: number;
  type: string;
  payload_json: string;
  correlation_id: string;
  causation_id: string | null;
  occurred_at: number;
};

function rowToSnapshot(row: RunSnapshotRow): RunSnapshot {
  return {
    runId: row.run_id as never,
    status: row.status as never,
    sequence: row.sequence,
    streamVersion: row.stream_version,
    restartCount: 0,
    createdAt: row.updated_at,
    updatedAt: row.updated_at,
  };
}

function snapshotPayload(
  row: RunSnapshotRow,
  sequence: number,
  streamVersion: number,
): Record<string, unknown> {
  return {
    status: row.status,
    sequence,
    streamVersion: streamVersion,
    updatedAt: Date.now(),
  };
}
