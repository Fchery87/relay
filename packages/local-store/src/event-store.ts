import {
  applySnapshot,
  reduceRun,
  replayRunFromEvents,
  RUN_STATUSES,
  type CanonicalEvent,
  type CanonicalEventDraft,
  type CommandReceipt,
  type CommandReceiptDraft,
  type CommandId,
  type EffectCancellation,
  type RunId,
  type RunCreatedEvent,
  type RunSnapshot,
  type RunStatus,
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
  /** Canonical occurrence time chosen by the command owner. */
  readonly occurredAt?: number;
  /** Snapshot already reduced by orchestration, the sole transition owner. */
  readonly nextSnapshot: RunSnapshot;
  /** Initial state to insert atomically when accepting a run.create command. */
  readonly initialSnapshot?: RunSnapshot;
  readonly events: ReadonlyArray<CanonicalEventDraft>;
  /** Identifies the immutable result that will be stored for redelivery. */
  readonly receipt?: CommandReceiptDraft;
  /** Durable reactor work committed atomically with events and the receipt. */
  readonly effects?: ReadonlyArray<EffectDraft>;
  readonly effectCancellations?: ReadonlyArray<EffectCancellation>;
  /** Effect currently persisting its own result; terminal cancellation excludes it. */
  readonly effectFence?: {
    readonly effectId: string;
  };
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
  const occurredAt = input.occurredAt ?? now;
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
          [input.runId, ev.turnId, occurredAt],
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
        occurredAt,
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
          occurredAt,
        ],
      );

      // Outbox row — publish every event
      db.run(
        `INSERT INTO projection_outbox (event_id, run_id, sequence, type, payload_json, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          ev.eventId,
          input.runId,
          seq,
          ev.type,
          JSON.stringify(ev.payload),
          occurredAt,
          now,
        ],
      );
    }

    if (input.nextSnapshot.runId !== input.runId) {
      throw new Error("Cannot persist a snapshot for a different run");
    }
    const snapshot: RunSnapshot = {
      ...input.nextSnapshot,
      sequence: seq,
      streamVersion: stream,
      updatedAt: occurredAt,
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

    for (const cancellation of input.effectCancellations ?? []) {
      cancelLiveEffects(
        db,
        input.runId,
        cancellation.kind,
        cancellation.reason,
        now,
        input.effectFence?.effectId,
      );
    }
    if (isTerminalStatus(snapshot.status)) {
      cancelLiveEffects(
        db,
        input.runId,
        undefined,
        `Run entered terminal state: ${snapshot.status}`,
        now,
        input.effectFence?.effectId,
      );
    }

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
  let result: AppendResult;
  try {
    result = alreadyInTransaction
      ? execute()
      : db.transaction(execute)();
  } catch (error) {
    if (!alreadyInTransaction && error instanceof PersistedRecordError) {
      quarantineCorruptRunById(db, input.runId, error);
    }
    throw error;
  }

  if (!alreadyInTransaction && result.ok && result.events.length > 0) {
    eventCommitNotifier(db).notify(input.runId);
  }

  return result;
}

export type TransactionalCommandInput = {
  readonly runId: RunId;
  readonly commandId: CommandId;
  readonly expectedStreamVersion?: number;
  readonly occurredAt?: number;
  readonly initialSnapshot?: RunSnapshot;
  readonly receipt?: CommandReceiptDraft;
  /** Result commands must still own a live effect lease when persisted. */
  readonly effectFence?: {
    readonly effectId: string;
    readonly leaseOwner: string;
    readonly now?: number;
  };
  readonly decide: (snapshot: RunSnapshot) => {
    readonly nextSnapshot: RunSnapshot;
    readonly events: ReadonlyArray<CanonicalEventDraft>;
    readonly effects?: ReadonlyArray<EffectDraft>;
    readonly effectCancellations?: ReadonlyArray<EffectCancellation>;
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
  let result: AppendResult;
  try {
    result = db.transaction((): AppendResult => {
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
            input.effectFence.now ?? Date.now(),
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
        occurredAt: input.occurredAt,
        initialSnapshot: input.initialSnapshot,
        nextSnapshot: decision.nextSnapshot,
        events: decision.events,
        receipt: input.receipt,
        effects: decision.effects,
        effectCancellations: decision.effectCancellations,
        effectFence: input.effectFence,
      });
    })();
  } catch (error) {
    if (error instanceof PersistedRecordError) {
      quarantineCorruptRunById(db, input.runId, error);
    }
    throw error;
  }

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
  if (!row) return undefined;
  try {
    return rowToSnapshot(row);
  } catch (error) {
    if (!(error instanceof PersistedRecordError)) throw error;
    return quarantineCorruptRun(db, row, error, false);
  }
}

export type RunDiagnostic = {
  readonly diagnosticId: string;
  readonly runId: RunId;
  readonly kind: "persisted_record_corrupt";
  readonly message: string;
  readonly createdAt: number;
};

export function listRunDiagnostics(
  db: StoreDatabase,
  runId: string,
): ReadonlyArray<RunDiagnostic> {
  const rows = db
    .query(
      `SELECT diagnostic_id, run_id, kind, message, created_at
       FROM run_diagnostics
       WHERE run_id = ?
       ORDER BY created_at, diagnostic_id`,
    )
    .all(runId) as RunDiagnosticRow[];
  return rows.map((row) => ({
    diagnosticId: row.diagnostic_id,
    runId: row.run_id as RunId,
    kind: "persisted_record_corrupt",
    message: row.message,
    createdAt: row.created_at,
  }));
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
  try {
    return decodeReceipt(row.result_json, commandId, runId);
  } catch (error) {
    if (error instanceof PersistedRecordError) {
      quarantineCorruptRunById(db, runId, error);
    }
    throw error;
  }
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

  const events: Array<EventEnvelope<CanonicalEventType, unknown>> = [];
  for (const row of rows) {
    try {
      events.push(rowToEvent(row));
    } catch (error) {
      if (error instanceof PersistedRecordError) {
        quarantineCorruptEvent(db, row, error);
        return getEventsAfter(db, runId, afterSequence);
      }
      throw error;
    }
  }
  return events;
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

type RunDiagnosticRow = {
  diagnostic_id: string;
  run_id: string;
  kind: "persisted_record_corrupt";
  message: string;
  created_at: number;
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

const runStatusSet = new Set<string>(RUN_STATUSES);

function quarantineCorruptRun(
  db: StoreDatabase,
  row: RunSnapshotRow,
  error: PersistedRecordError,
  force: boolean,
): RunSnapshot {
  const now = Date.now();
  const runId = row.run_id as RunId;
  const diagnosticId = `diag-persisted-record-corrupt-${row.run_id}`;
  const eventId = `ev-persisted-record-corrupt-${row.run_id}`;
  const message = error.message.slice(0, 512);

  let repaired!: RunSnapshot;
  let eventCommitted = false;
  db.transaction(() => {
    const currentRow = db
      .query("SELECT * FROM run_snapshots WHERE run_id = ?")
      .get(row.run_id) as RunSnapshotRow | undefined;
    if (!currentRow) {
      throw new PersistedRecordError(
        `Corrupt run snapshot disappeared during quarantine: ${row.run_id}`,
      );
    }

    let validSnapshot: RunSnapshot | undefined;
    try {
      validSnapshot = rowToSnapshot(currentRow);
    } catch (currentError) {
      if (!(currentError instanceof PersistedRecordError)) throw currentError;
    }
    const existingDiagnostic = db
      .query(
        `SELECT diagnostic_id
         FROM run_diagnostics
         WHERE run_id = ? AND kind = 'persisted_record_corrupt'`,
      )
      .get(row.run_id) as { diagnostic_id: string } | undefined;
    if (validSnapshot && (existingDiagnostic || !force)) {
      repaired = validSnapshot;
      return;
    }

    db.run(
      `INSERT OR IGNORE INTO run_diagnostics
       (diagnostic_id, run_id, kind, message, created_at)
       VALUES (?, ?, 'persisted_record_corrupt', ?, ?)`,
      [diagnosticId, row.run_id, message, now],
    );

    const status: RunStatus = runStatusSet.has(currentRow.status)
      ? currentRow.status as RunStatus
      : "created";
    const latest = db
      .query(
        `SELECT COALESCE(MAX(sequence), 0) AS sequence,
                COALESCE(MAX(stream_version), 0) AS stream_version
         FROM run_events
         WHERE run_id = ?`,
      )
      .get(row.run_id) as { sequence: number; stream_version: number };
    // Snapshot scalar columns are part of the corrupt record and cannot be
    // trusted to choose canonical event coordinates.
    const sequence = nonNegativeInteger(latest.sequence);
    const streamVersion = nonNegativeInteger(latest.stream_version);
    const base: RunSnapshot = {
      ...(validSnapshot ?? {
        runId,
        status,
        sequence,
        streamVersion,
        restartCount: 0,
        createdAt: currentRow.updated_at,
        updatedAt: currentRow.updated_at,
      }),
      sequence,
      streamVersion,
      reducerPayload: {
        ...(validSnapshot?.reducerPayload ?? {}),
        diagnosticId,
        diagnosticKind: "persisted_record_corrupt",
        diagnosticMessage: message,
      },
    };

    if (isTerminalStatus(status)) {
      repaired = base;
    } else {
      const event: CanonicalEvent = {
        eventId: eventId as never,
        sequence: sequence + 1,
        streamVersion: streamVersion + 1,
        type: "run.failed",
        runId,
        correlationId: diagnosticId as never,
        occurredAt: now,
        payload: { error: message },
      };
      repaired = {
        ...applySnapshot(base, reduceRun(base, event)),
        sequence: event.sequence,
        streamVersion: event.streamVersion,
      };
      const inserted = db.run(
        `INSERT OR IGNORE INTO run_events
         (event_id, run_id, sequence, stream_version, type, payload_json,
          turn_id, provider_instance_id, correlation_id, causation_id, occurred_at)
         VALUES (?, ?, ?, ?, 'run.failed', ?, NULL, NULL, ?, NULL, ?)`,
        [
          eventId,
          row.run_id,
          event.sequence,
          event.streamVersion,
          encodeEventPayload("run.failed", event.payload),
          diagnosticId,
          now,
        ],
      );
      if (inserted.changes === 1) {
        db.run(
          `INSERT INTO projection_outbox
           (event_id, run_id, sequence, type, payload_json, occurred_at, created_at)
           VALUES (?, ?, ?, 'run.failed', ?, ?, ?)`,
          [
            eventId,
            row.run_id,
            event.sequence,
            JSON.stringify(event.payload),
            now,
            now,
          ],
        );
        eventCommitted = true;
      }
    }

    db.run(
      `UPDATE run_snapshots
       SET status = ?, sequence = ?, stream_version = ?, payload_json = ?, updated_at = ?
       WHERE run_id = ?`,
      [
        repaired.status,
        repaired.sequence,
        repaired.streamVersion,
        encodeSnapshot(repaired),
        repaired.updatedAt,
        row.run_id,
      ],
    );
    cancelLiveEffects(
      db,
      runId,
      undefined,
      "Run quarantined after persisted-record corruption",
      now,
    );
  })();

  if (eventCommitted) {
    eventCommitNotifier(db).notify(runId);
  }
  return repaired;
}

function quarantineCorruptEvent(
  db: StoreDatabase,
  corruptRow: EventRow,
  error: PersistedRecordError,
): void {
  const now = Date.now();
  const runId = corruptRow.run_id as RunId;
  const diagnosticId = `diag-persisted-record-corrupt-${corruptRow.run_id}`;
  const failureEventId = `ev-persisted-record-corrupt-${corruptRow.run_id}`;
  const syntheticCreatedEventId =
    `ev-persisted-record-recovery-created-${corruptRow.run_id}`;
  const message = error.message.slice(0, 512);
  let committed = false;

  db.transaction(() => {
    const snapshotRow = db
      .query("SELECT * FROM run_snapshots WHERE run_id = ?")
      .get(corruptRow.run_id) as RunSnapshotRow | undefined;
    if (!snapshotRow) return;

    let validSnapshot: RunSnapshot | undefined;
    try {
      validSnapshot = rowToSnapshot(snapshotRow);
    } catch (snapshotError) {
      if (!(snapshotError instanceof PersistedRecordError)) throw snapshotError;
    }

    const prefixRows = db
      .query(
        `SELECT * FROM run_events
         WHERE run_id = ? AND sequence < ?
         ORDER BY sequence ASC`,
      )
      .all(corruptRow.run_id, corruptRow.sequence) as EventRow[];
    let prefix = prefixRows.map(rowToEvent) as CanonicalEvent[];
    let base: RunSnapshot | undefined;
    try {
      base = replayRunFromEvents(prefix);
    } catch {
      // Legacy streams may predate run.created. Archive the whole stream and
      // replace it with a minimal canonical genesis before failing closed.
      prefix = [];
    }

    const archiveFromSequence =
      prefix.length > 0 ? corruptRow.sequence : 0;
    db.run(
      `INSERT OR IGNORE INTO quarantined_run_events
       (event_id, run_id, sequence, stream_version, type, payload_json,
        turn_id, provider_instance_id, correlation_id, causation_id,
        occurred_at, diagnostic_id, quarantined_at)
       SELECT event_id, run_id, sequence, stream_version, type, payload_json,
              turn_id, provider_instance_id, correlation_id, causation_id,
              occurred_at, ?, ?
       FROM run_events
       WHERE run_id = ? AND sequence >= ?`,
      [diagnosticId, now, corruptRow.run_id, archiveFromSequence],
    );
    db.run(
      `DELETE FROM projection_outbox
       WHERE event_id IN (
         SELECT event_id FROM run_events
         WHERE run_id = ? AND sequence >= ?
       )`,
      [corruptRow.run_id, archiveFromSequence],
    );
    db.run(
      `DELETE FROM run_events WHERE run_id = ? AND sequence >= ?`,
      [corruptRow.run_id, archiveFromSequence],
    );

    db.run(
      `INSERT OR IGNORE INTO run_diagnostics
       (diagnostic_id, run_id, kind, message, created_at)
       VALUES (?, ?, 'persisted_record_corrupt', ?, ?)`,
      [diagnosticId, corruptRow.run_id, message, now],
    );

    if (!base) {
      const createdAt = validSnapshot?.createdAt ?? snapshotRow.updated_at;
      const created: RunCreatedEvent = {
        eventId: syntheticCreatedEventId as never,
        sequence: 1,
        streamVersion: 1,
        type: "run.created",
        runId,
        correlationId: diagnosticId as never,
        occurredAt: createdAt,
        payload: {
          environmentId: "quarantine" as never,
          projectId:
            validSnapshot?.projectId ?? (`quarantined-${runId}` as never),
          ...(validSnapshot?.permissionProfile === undefined
            ? {}
            : { permissionProfile: validSnapshot.permissionProfile }),
        },
      };
      insertCanonicalEvent(db, created, now);
      prefix = [created];
      base = replayRunFromEvents(prefix);
    }

    const failure: CanonicalEvent = {
      eventId: failureEventId as never,
      sequence: base.sequence + 1,
      streamVersion: base.streamVersion + 1,
      type: "run.failed",
      runId,
      correlationId: diagnosticId as never,
      occurredAt: now,
      payload: { error: message },
    };
    insertCanonicalEvent(db, failure, now);
    const repaired = {
      ...applySnapshot(base, reduceRun(base, failure)),
      sequence: failure.sequence,
      streamVersion: failure.streamVersion,
      reducerPayload: {
        ...(base.reducerPayload ?? {}),
        diagnosticId,
        diagnosticKind: "persisted_record_corrupt",
        diagnosticMessage: message,
      },
    };
    db.run(
      `UPDATE run_snapshots
       SET status = ?, sequence = ?, stream_version = ?, payload_json = ?, updated_at = ?
       WHERE run_id = ?`,
      [
        repaired.status,
        repaired.sequence,
        repaired.streamVersion,
        encodeSnapshot(repaired),
        repaired.updatedAt,
        corruptRow.run_id,
      ],
    );
    cancelLiveEffects(
      db,
      runId,
      undefined,
      "Run quarantined after persisted-record corruption",
      now,
    );
    committed = true;
  })();

  if (committed) eventCommitNotifier(db).notify(runId);
}

function insertCanonicalEvent(
  db: StoreDatabase,
  event: CanonicalEvent,
  createdAt: number,
): void {
  db.run(
    `INSERT INTO run_events
     (event_id, run_id, sequence, stream_version, type, payload_json,
      turn_id, provider_instance_id, correlation_id, causation_id, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.eventId,
      event.runId,
      event.sequence,
      event.streamVersion,
      event.type,
      encodeEventPayload(event.type, event.payload),
      event.turnId ?? null,
      event.providerInstanceId ?? null,
      event.correlationId,
      event.causationId ?? null,
      event.occurredAt,
    ],
  );
  db.run(
    `INSERT INTO projection_outbox
     (event_id, run_id, sequence, type, payload_json, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      event.eventId,
      event.runId,
      event.sequence,
      event.type,
      JSON.stringify(event.payload),
      event.occurredAt,
      createdAt,
    ],
  );
}

function quarantineCorruptRunById(
  db: StoreDatabase,
  runId: RunId,
  error: PersistedRecordError,
): RunSnapshot | undefined {
  const row = db
    .query("SELECT * FROM run_snapshots WHERE run_id = ?")
    .get(runId) as RunSnapshotRow | undefined;
  return row ? quarantineCorruptRun(db, row, error, true) : undefined;
}

function nonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "stopped" || status === "completed" || status === "failed";
}

function cancelLiveEffects(
  db: StoreDatabase,
  runId: RunId,
  kind: string | undefined,
  reason: string,
  now: number,
  exceptEffectId?: string,
): void {
  db.run(
    `UPDATE effect_outbox
     SET status = 'failed',
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error = ?,
         last_error_kind = 'terminal',
         next_attempt_at = 0,
         failed_at = ?,
         updated_at = ?
     WHERE run_id = ?
       AND status IN ('pending', 'running')
       AND (? IS NULL OR kind = ?)
       AND (? IS NULL OR effect_id != ?)`,
    [
      reason,
      now,
      now,
      runId,
      kind ?? null,
      kind ?? null,
      exceptEffectId ?? null,
      exceptEffectId ?? null,
    ],
  );
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
