import type { StoreDatabase } from "./database";
import { createHash } from "node:crypto";

const DAY_MS = 86_400_000;
const TERMINAL_STATUSES = ["stopped", "completed", "failed"] as const;

export type RetentionPolicy = Readonly<{
  terminalEventMs: number;
  diagnosticsMs: number;
  acknowledgedOutboxMs: number;
  checkpointMs: number;
  historySnapshotMs: number;
  quarantinedEventMs: number;
}>;

export const DEFAULT_RETENTION: RetentionPolicy = {
  terminalEventMs: 90 * DAY_MS,
  diagnosticsMs: 30 * DAY_MS,
  acknowledgedOutboxMs: 7 * DAY_MS,
  checkpointMs: 90 * DAY_MS,
  historySnapshotMs: 30 * DAY_MS,
  quarantinedEventMs: 30 * DAY_MS,
};

export type StoragePressurePolicy = Readonly<{
  warnAtBytes: number;
  criticalAtBytes: number;
}>;

export const DEFAULT_STORAGE_PRESSURE: StoragePressurePolicy = {
  warnAtBytes: 512 * 1024 * 1024,
  criticalAtBytes: 1024 * 1024 * 1024,
};

export type StorageStats = Readonly<{
  pageCount: number;
  pageSize: number;
  freePages: number;
  databaseBytes: number;
  freeBytes: number;
}>;

export type RetentionResult = Readonly<{
  now: number;
  deletedEvents: number;
  deletedOutboxRows: number;
  deletedDiagnostics: number;
  deletedCheckpoints: number;
  deletedHistorySnapshots: number;
  deletedQuarantinedEvents: number;
  before: StorageStats;
  after: StorageStats;
  pressure: "normal" | "warning" | "critical";
}>;

export function validateRetention(policy: RetentionPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid retention ${name}`);
  }
}

export function validateStoragePressure(policy: StoragePressurePolicy): void {
  if (!Number.isFinite(policy.warnAtBytes) || !Number.isFinite(policy.criticalAtBytes) || policy.warnAtBytes < 0 || policy.criticalAtBytes < policy.warnAtBytes) {
    throw new Error("Invalid storage pressure thresholds");
  }
}

export function getStorageStats(db: StoreDatabase): StorageStats {
  const pageCount = pragmaNumber(db, "page_count");
  const pageSize = pragmaNumber(db, "page_size");
  const freePages = pragmaNumber(db, "freelist_count");
  return {
    pageCount,
    pageSize,
    freePages,
    databaseBytes: pageCount * pageSize,
    freeBytes: freePages * pageSize,
  };
}

/**
 * Apply bounded local-store retention in one transaction.
 *
 * Terminal event history is prunable only after a verified history snapshot
 * covers the complete run sequence. Unacknowledged outbox rows and
 * non-terminal runs are always retained. Checkpoints are only physically
 * removed after their `gc` marker has been set by workspace/ref cleanup.
 */
export function enforceRetention(
  db: StoreDatabase,
  options: {
    readonly now?: number;
    readonly policy?: RetentionPolicy;
    readonly pressure?: StoragePressurePolicy;
    readonly vacuum?: boolean;
  } = {},
): RetentionResult {
  const now = options.now ?? Date.now();
  const policy = options.policy ?? DEFAULT_RETENTION;
  const pressurePolicy = options.pressure ?? DEFAULT_STORAGE_PRESSURE;
  validateRetention(policy);
  validateStoragePressure(pressurePolicy);
  const before = getStorageStats(db);
  let counts = {
    deletedEvents: 0,
    deletedOutboxRows: 0,
    deletedDiagnostics: 0,
    deletedCheckpoints: 0,
    deletedHistorySnapshots: 0,
    deletedQuarantinedEvents: 0,
  };

  const compactableRunIds = verifiedCompactableRuns(db, now - policy.terminalEventMs);

  db.transaction(() => {
    const eventCutoff = now - policy.terminalEventMs;
    if (compactableRunIds.length > 0) {
      const placeholders = compactableRunIds.map(() => "?").join(",");
      const eventResult = db.run(
        `DELETE FROM run_events
         WHERE occurred_at <= ?
           AND run_id IN (${placeholders})
           AND NOT EXISTS (SELECT 1 FROM projection_outbox WHERE projection_outbox.event_id = run_events.event_id AND acknowledged = 0)`,
        [eventCutoff, ...compactableRunIds],
      );
      counts.deletedEvents = eventResult.changes;
    }

    const outboxResult = db.run(
      "DELETE FROM projection_outbox WHERE acknowledged = 1 AND occurred_at <= ?",
      [now - policy.acknowledgedOutboxMs],
    );
    counts.deletedOutboxRows = outboxResult.changes;

    const diagnosticResult = db.run(
      "DELETE FROM run_diagnostics WHERE created_at <= ?",
      [now - policy.diagnosticsMs],
    );
    counts.deletedDiagnostics = diagnosticResult.changes;

    const historyResult = db.run(
      `DELETE FROM history_snapshots
       WHERE created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM history_snapshots newer
           WHERE newer.run_id = history_snapshots.run_id
             AND newer.through_sequence > history_snapshots.through_sequence
         )`,
      [now - policy.historySnapshotMs],
    );
    counts.deletedHistorySnapshots = historyResult.changes;

    const checkpointResult = db.run(
      "DELETE FROM checkpoints WHERE gc = 1 AND created_at <= ?",
      [now - policy.checkpointMs],
    );
    counts.deletedCheckpoints = checkpointResult.changes;
    const quarantinedResult = db.run(
      "DELETE FROM quarantined_run_events WHERE quarantined_at <= ?",
      [now - policy.quarantinedEventMs],
    );
    counts.deletedQuarantinedEvents = quarantinedResult.changes;

    db.run(
      `DELETE FROM run_turns
       WHERE NOT EXISTS (SELECT 1 FROM run_events WHERE run_events.run_id = run_turns.run_id AND run_events.turn_id = run_turns.turn_id)`,
    );
  })();

  let after = getStorageStats(db);
  if (options.vacuum === true) {
    db.run("VACUUM");
    after = getStorageStats(db);
  }
  return { now, ...counts, before, after, pressure: pressureLevel(after.databaseBytes, pressurePolicy) };
}

function pressureLevel(bytes: number, policy: StoragePressurePolicy): "normal" | "warning" | "critical" {
  return bytes >= policy.criticalAtBytes ? "critical" : bytes >= policy.warnAtBytes ? "warning" : "normal";
}

function pragmaNumber(db: StoreDatabase, name: "page_count" | "page_size" | "freelist_count"): number {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
  const value = row ? Object.values(row)[0] : 0;
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** Mark a checkpoint only after its backing Git ref has been removed. */
export function markCheckpointForGc(db: StoreDatabase, checkpointId: string): boolean {
  return db.run("UPDATE checkpoints SET gc = 1 WHERE checkpoint_id = ? AND gc = 0", [checkpointId]).changes === 1;
}

function verifiedCompactableRuns(db: StoreDatabase, cutoff: number): string[] {
  const rows = db.query(
    `SELECT s.run_id, s.sequence, h.hash, h.payload_json
     FROM run_snapshots s
     JOIN history_snapshots h ON h.run_id = s.run_id AND h.through_sequence >= s.sequence
     WHERE s.status IN (?, ?, ?) AND s.updated_at <= ?
     ORDER BY h.through_sequence DESC`,
  ).all(...TERMINAL_STATUSES, cutoff) as Array<{ run_id: string; sequence: number; hash: string; payload_json: string }>;
  const verified = new Set<string>();
  for (const row of rows) {
    if (verified.has(row.run_id)) continue;
    try {
      const hash = createHash("sha256").update(row.payload_json).digest("hex");
      JSON.parse(row.payload_json);
      if (hash === row.hash) verified.add(row.run_id);
    } catch {
      // Corrupt or incomplete history snapshots must block event pruning.
    }
  }
  return [...verified];
}
