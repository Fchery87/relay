import {
  type CanonicalEventDraft,
  type CommandReceipt,
  type CommandReceiptDraft,
  type CommandId,
  type RunId,
  type RunSnapshot,
} from "@relay/contracts";
import type { CanonicalEventType, EventEnvelope } from "@relay/contracts";
import type { StoreDatabase } from "./database";
import { insertEffect, type EffectDraft } from "./effect-store";
import {
  decodeEventPayload,
  decodeReceipt,
  decodeSnapshot,
  encodeEventPayload,
  encodeReceipt,
  encodeSnapshot,
  PersistedRecordError,
} from "./persistence-codecs";

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export type AppendInput = {
  readonly runId: RunId;
  readonly commandId: CommandId;
  /** If provided, reject if the current stream version doesn't match. */
  readonly expectedStreamVersion?: number;
  /** Snapshot already reduced by orchestration, the sole transition owner. */
  readonly nextSnapshot: RunSnapshot;
  /** Initial state to insert atomically when accepting a run.create command. */
  readonly initialSnapshot?: RunSnapshot;
  readonly events: ReadonlyArray<CanonicalEventDraft>;
  /** Identifies the immutable result that will be stored for redelivery. */
  readonly receipt?: CommandReceiptDraft;
  /** Durable reactor work committed atomically with events and the receipt. */
  readonly effects?: ReadonlyArray<EffectDraft>;
};

export type AppendResult =
  | {
      readonly ok: true;
      readonly snapshot: RunSnapshot;
      readonly receipt: CommandReceipt;
      readonly events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "duplicate_command"
        | "version_conflict"
        | "run_not_found"
        | "effect_lease_lost";
      /** If duplicate, the original receipt result. */
      readonly duplicateReceipt?: CommandReceipt;
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
  const alreadyInTransaction = db.inTransaction;

  const execute = (): AppendResult => {
    // 1. Duplicate check
    const existing = db
      .query("SELECT run_id, result_json FROM command_receipts WHERE command_id = ?")
      .get(input.commandId) as {
        run_id: string;
        result_json: string | null;
      } | undefined;

    if (existing) {
      if (existing.run_id !== input.runId) {
        throw new Error("Command ID is already bound to a different run");
      }
      // Idempotent: return the cached snapshot from the original receipt.
      if (existing.result_json) {
        const cached = decodeReceipt(
          existing.result_json,
          input.commandId,
          input.runId,
        );
        return { ok: false, reason: "duplicate_command", duplicateReceipt: cached };
      }
      const dup = db
        .query("SELECT * FROM run_snapshots WHERE run_id = ?")
        .get(input.runId) as RunSnapshotRow | undefined;

      return {
        ok: false,
        reason: "duplicate_command",
        duplicateReceipt: dup
          ? createReceipt(
              input.commandId,
              input.runId,
              rowToSnapshot(dup),
              input.receipt ?? { kind: "snapshot" },
            )
          : undefined,
      };
    }

    // 2. Load snapshot
    let row = db
      .query("SELECT * FROM run_snapshots WHERE run_id = ?")
      .get(input.runId) as RunSnapshotRow | undefined;

    if (row && input.initialSnapshot) {
      return { ok: false, reason: "version_conflict" };
    }
    if (!row && input.initialSnapshot) {
      if (input.initialSnapshot.runId !== input.runId) {
        throw new Error("Cannot create a snapshot for a different run");
      }
      insertSnapshot(db, input.initialSnapshot);
      row = db
        .query("SELECT * FROM run_snapshots WHERE run_id = ?")
        .get(input.runId) as RunSnapshotRow | undefined;
    }

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
      if (ev.type === "turn.started") {
        if (!ev.turnId) {
          throw new Error("turn.started requires a turn ID");
        }
        const inserted = db.run(
          `INSERT OR IGNORE INTO run_turns (run_id, turn_id, started_at)
           VALUES (?, ?, ?)`,
          [input.runId, ev.turnId, now],
        );
        if (inserted.changes !== 1) {
          throw new Error(
            `Turn ID is already bound to this run: ${ev.turnId}`,
          );
        }
      }
      const envelope: EventEnvelope<CanonicalEventType, unknown> = {
        eventId: ev.eventId as never,
        sequence: seq,
        streamVersion: stream,
        type: ev.type,
        runId: input.runId as never,
        turnId: ev.turnId,
        providerInstanceId: ev.providerInstanceId,
        correlationId: ev.correlationId as never,
        causationId: ev.causationId as never,
        occurredAt: now,
        payload: ev.payload,
      };
      envelopes.push(envelope);
      db.run(
        `INSERT INTO run_events (event_id, run_id, sequence, stream_version, type, payload_json, turn_id, provider_instance_id, correlation_id, causation_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ev.eventId,
          input.runId,
          seq,
          stream,
          ev.type,
          encodeEventPayload(ev.type, ev.payload),
          ev.turnId ?? null,
          ev.providerInstanceId ?? null,
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

    if (input.nextSnapshot.runId !== input.runId) {
      throw new Error("Cannot persist a snapshot for a different run");
    }
    const snapshot: RunSnapshot = {
      ...input.nextSnapshot,
      sequence: seq,
      streamVersion: stream,
      updatedAt: now,
    };

    // Update snapshot
    db.run(
      `UPDATE run_snapshots
       SET status = ?, sequence = ?, stream_version = ?, payload_json = ?, updated_at = ?
       WHERE run_id = ?`,
      [
        snapshot.status,
        seq,
        stream,
        encodeSnapshot(snapshot),
        snapshot.updatedAt,
        input.runId,
      ],
    );

    const receipt = createReceipt(
      input.commandId,
      input.runId,
      snapshot,
      input.receipt ?? { kind: "snapshot" },
    );

    for (const effect of input.effects ?? []) {
      if (effect.runId !== input.runId || effect.commandId !== input.commandId) {
        throw new Error("Effect identity does not match its command");
      }
      insertEffect(db, effect, now);
    }

    // 5. Command receipt — store the full immutable result for redelivery.
    db.run(
      `INSERT INTO command_receipts (command_id, run_id, completed_at, result_json) VALUES (?, ?, ?, ?)`,
      [input.commandId, input.runId, now, encodeReceipt(receipt)],
    );

    return {
      ok: true,
      snapshot,
      receipt,
      events: envelopes,
    };
  };
  const result = alreadyInTransaction
    ? execute()
    : db.transaction(execute)();

  if (!alreadyInTransaction && result.ok && result.events.length > 0) {
    eventCommitNotifier(db).notify(input.runId);
  }

  return result;
}

export type TransactionalCommandInput = {
  readonly runId: RunId;
  readonly commandId: CommandId;
  readonly expectedStreamVersion?: number;
  readonly initialSnapshot?: RunSnapshot;
  readonly receipt?: CommandReceiptDraft;
  /** Result commands must still own a live effect lease when persisted. */
  readonly effectFence?: {
    readonly effectId: string;
    readonly leaseOwner: string;
  };
  readonly decide: (snapshot: RunSnapshot) => {
    readonly nextSnapshot: RunSnapshot;
    readonly events: ReadonlyArray<CanonicalEventDraft>;
    readonly effects?: ReadonlyArray<EffectDraft>;
  };
};

/**
 * Load, decide, reduce, persist effects/events, and complete the receipt under
 * one SQLite write transaction. The callback must remain pure and synchronous.
 */
export function transactCommand(
  db: StoreDatabase,
  input: TransactionalCommandInput,
): AppendResult {
  const result = db.transaction((): AppendResult => {
    const existing = db
      .query("SELECT run_id, result_json FROM command_receipts WHERE command_id = ?")
      .get(input.commandId) as {
        run_id: string;
        result_json: string | null;
      } | undefined;
    if (existing) {
      if (existing.run_id !== input.runId) {
        throw new Error("Command ID is already bound to a different run");
      }
      const snapshotRow = db
        .query("SELECT * FROM run_snapshots WHERE run_id = ?")
        .get(input.runId) as RunSnapshotRow | undefined;
      const duplicateReceipt = existing.result_json
        ? decodeReceipt(existing.result_json, input.commandId, input.runId)
        : snapshotRow
          ? createReceipt(
              input.commandId,
              input.runId,
              rowToSnapshot(snapshotRow),
              input.receipt ?? { kind: "snapshot" },
            )
          : undefined;
      return {
        ok: false,
        reason: "duplicate_command",
        duplicateReceipt,
      };
    }

    if (input.effectFence) {
      const fenced = db.run(
        `UPDATE effect_outbox
         SET updated_at = updated_at
         WHERE effect_id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND lease_expires_at > ?`,
        [
          input.effectFence.effectId,
          input.effectFence.leaseOwner,
          Date.now(),
        ],
      );
      if (fenced.changes !== 1) {
        return { ok: false, reason: "effect_lease_lost" };
      }
    }

    const row = db
      .query("SELECT * FROM run_snapshots WHERE run_id = ?")
      .get(input.runId) as RunSnapshotRow | undefined;
    if (row && input.initialSnapshot) {
      return { ok: false, reason: "version_conflict" };
    }
    const snapshot = row
      ? rowToSnapshot(row)
      : input.initialSnapshot;
    if (!snapshot) {
      return { ok: false, reason: "run_not_found" };
    }
    if (
      input.expectedStreamVersion !== undefined &&
      input.expectedStreamVersion !== snapshot.streamVersion
    ) {
      return { ok: false, reason: "version_conflict" };
    }

    const decision = input.decide(snapshot);
    return appendEvents(db, {
      runId: input.runId,
      commandId: input.commandId,
      expectedStreamVersion:
        input.expectedStreamVersion ?? snapshot.streamVersion,
      initialSnapshot: input.initialSnapshot,
      nextSnapshot: decision.nextSnapshot,
      events: decision.events,
      receipt: input.receipt,
      effects: decision.effects,
    });
  })();

  if (result.ok && result.events.length > 0) {
    eventCommitNotifier(db).notify(input.runId);
  }
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
      encodeSnapshot(snapshot),
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

export function getCommandReceipt(
  db: StoreDatabase,
  commandId: CommandId,
  runId: RunId,
): CommandReceipt | undefined {
  const row = db
    .query("SELECT run_id, result_json FROM command_receipts WHERE command_id = ?")
    .get(commandId) as {
      run_id: string;
      result_json: string | null;
    } | undefined;
  if (row && row.run_id !== runId) {
    throw new Error("Command ID is already bound to a different run");
  }
  if (!row?.result_json) return undefined;
  return decodeReceipt(row.result_json, commandId, runId);
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

// ---------------------------------------------------------------------------
// Commit observation
// ---------------------------------------------------------------------------

/**
 * Return the process-local commit generation for a run. Consumers pair this
 * with waitForEventCommit, which also wakes periodically to observe commits
 * made through another SQLite connection or process.
 */
export function getEventCommitVersion(
  db: StoreDatabase,
  runId: RunId,
): number {
  return eventCommitNotifier(db).version(runId);
}

export function waitForEventCommit(
  db: StoreDatabase,
  runId: RunId,
  observedVersion: number,
  signal?: AbortSignal,
): Promise<number> {
  return eventCommitNotifier(db).waitForChange(runId, observedVersion, signal);
}

function rowToEvent(row: EventRow): EventEnvelope<CanonicalEventType, unknown> {
  return {
    eventId: row.event_id as never,
    sequence: row.sequence,
    streamVersion: row.stream_version,
    type: row.type as CanonicalEventType,
    runId: row.run_id as never,
    turnId: (row.turn_id ?? undefined) as never,
    providerInstanceId: (row.provider_instance_id ?? undefined) as never,
    correlationId: row.correlation_id as never,
    causationId: (row.causation_id ?? undefined) as never,
    occurredAt: row.occurred_at,
    payload: decodeEventPayload(row.type as CanonicalEventType, row.payload_json),
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
  turn_id: string | null;
  provider_instance_id: string | null;
  correlation_id: string;
  causation_id: string | null;
  occurred_at: number;
};

function rowToSnapshot(row: RunSnapshotRow): RunSnapshot {
  const snapshot = decodeSnapshot(row.payload_json);
  if (
    snapshot.runId !== row.run_id ||
    snapshot.status !== row.status ||
    snapshot.sequence !== row.sequence ||
    snapshot.streamVersion !== row.stream_version ||
    snapshot.updatedAt !== row.updated_at
  ) {
    throw new PersistedRecordError(
      `Run snapshot columns do not match payload for ${row.run_id}`,
    );
  }
  return snapshot;
}

function createReceipt(
  commandId: CommandId,
  runId: RunId,
  snapshot: RunSnapshot,
  draft: CommandReceiptDraft,
): CommandReceipt {
  if (draft.kind === "turn") {
    return {
      schemaVersion: 1,
      kind: "turn",
      commandId,
      runId,
      turnId: draft.turnId,
      snapshot,
    };
  }
  return {
    schemaVersion: 1,
    kind: "snapshot",
    commandId,
    runId,
    snapshot,
  };
}

const EVENT_COMMIT_POLL_MS = 50;
const eventCommitNotifiers = new WeakMap<StoreDatabase, EventCommitNotifier>();

function eventCommitNotifier(db: StoreDatabase): EventCommitNotifier {
  const existing = eventCommitNotifiers.get(db);
  if (existing) return existing;
  const created = new EventCommitNotifier();
  eventCommitNotifiers.set(db, created);
  return created;
}

class EventCommitNotifier {
  private readonly versions = new Map<RunId, number>();
  private readonly waiters = new Map<RunId, Set<() => void>>();

  version(runId: RunId): number {
    return this.versions.get(runId) ?? 0;
  }

  notify(runId: RunId): void {
    const nextVersion = this.version(runId) + 1;
    this.versions.set(runId, nextVersion);
    const waiters = this.waiters.get(runId);
    if (!waiters) return;
    this.waiters.delete(runId);
    for (const wake of waiters) wake();
  }

  waitForChange(
    runId: RunId,
    observedVersion: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const currentVersion = this.version(runId);
    if (signal?.aborted || currentVersion !== observedVersion) {
      return Promise.resolve(currentVersion);
    }

    return new Promise<number>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(pollTimer);
        signal?.removeEventListener("abort", finish);
        const runWaiters = this.waiters.get(runId);
        runWaiters?.delete(finish);
        if (runWaiters?.size === 0) this.waiters.delete(runId);
        resolve(this.version(runId));
      };
      const pollTimer = setTimeout(finish, EVENT_COMMIT_POLL_MS);
      const runWaiters = this.waiters.get(runId) ?? new Set();
      runWaiters.add(finish);
      this.waiters.set(runId, runWaiters);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
}
