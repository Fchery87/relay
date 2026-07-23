import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StoreDatabase } from "./database";
import { getStorageStats, type StorageStats } from "./retention";
import { sanitizeForProjection } from "./security";

const MAX_DIAGNOSTICS = 100;
const MAX_RUNS = 500;
const MAX_MESSAGE_LENGTH = 512;

export type DiagnosticRunSummary = Readonly<{
  /** Stable only within this export; the raw run ID is never included. */
  readonly id: string;
  readonly status: string;
  readonly sequence: number;
  readonly eventCount: number;
  readonly updatedAt: number;
}>;

export type DiagnosticExport = Readonly<{
  schemaVersion: 1;
  exportedAt: number;
  exportId: string;
  redaction: "anonymized-v1";
  storage: StorageStats;
  runs: Readonly<{
    count: number;
    truncated: boolean;
    statuses: Readonly<Record<string, number>>;
    items: ReadonlyArray<DiagnosticRunSummary>;
  }>;
  events: Readonly<{ count: number; byType: Readonly<Record<string, number>> }>;
  outbox: Readonly<{ pending: number; acknowledged: number }>;
  effects: Readonly<Record<string, number>>;
  diagnostics: ReadonlyArray<{
    kind: string;
    message: string;
    createdAt: number;
  }>;
}>;

/**
 * Build a bounded, anonymized state dump for operator diagnostics.
 *
 * Event and effect payloads are intentionally excluded. Identifiers are
 * salted per export so operators can correlate rows in one bundle without
 * learning the daemon's raw run IDs.
 */
export function createDiagnosticExport(
  db: StoreDatabase,
  options: { readonly now?: number; readonly exportId?: string } = {},
): DiagnosticExport {
  const exportedAt = options.now ?? Date.now();
  const exportId = options.exportId ?? crypto.randomUUID();
  const salt = crypto.randomUUID();
  const anonymize = (value: string): string =>
    createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 16);

  const runRows = db.query(
    `SELECT run_id, status, sequence, updated_at
     FROM run_snapshots
     ORDER BY updated_at DESC, run_id ASC
     LIMIT ?`,
  ).all(MAX_RUNS + 1) as Array<{ run_id: string; status: string; sequence: number; updated_at: number }>;
  const truncated = runRows.length > MAX_RUNS;
  const items = runRows.slice(0, MAX_RUNS).map((row) => {
    const count = db.query("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?")
      .get(row.run_id) as { count: number };
    return {
      id: anonymize(row.run_id),
      status: row.status,
      sequence: row.sequence,
      eventCount: count.count,
      updatedAt: row.updated_at,
    };
  });

  const statuses = Object.fromEntries((db.query(
    "SELECT status, COUNT(*) AS count FROM run_snapshots GROUP BY status ORDER BY status",
  ).all() as Array<{ status: string; count: number }>).map((row) => [row.status, row.count]));
  const byType = Object.fromEntries((db.query(
    "SELECT type, COUNT(*) AS count FROM run_events GROUP BY type ORDER BY type",
  ).all() as Array<{ type: string; count: number }>).map((row) => [row.type, row.count]));
  const outbox = db.query(
    "SELECT acknowledged, COUNT(*) AS count FROM projection_outbox GROUP BY acknowledged",
  ).all() as Array<{ acknowledged: number; count: number }>;
  const effects = Object.fromEntries((db.query(
    "SELECT status, COUNT(*) AS count FROM effect_outbox GROUP BY status ORDER BY status",
  ).all() as Array<{ status: string; count: number }>).map((row) => [row.status, row.count]));
  const diagnostics = (db.query(
    `SELECT kind, message, created_at
     FROM run_diagnostics
     ORDER BY created_at DESC, diagnostic_id DESC
     LIMIT ?`,
  ).all(MAX_DIAGNOSTICS) as Array<{ kind: string; message: string; created_at: number }>).map((row) => ({
    kind: row.kind,
    message: redactDiagnosticText(row.message),
    createdAt: row.created_at,
  }));

  return {
    schemaVersion: 1,
    exportedAt,
    exportId,
    redaction: "anonymized-v1",
    storage: getStorageStats(db),
    runs: {
      count: Number((db.query("SELECT COUNT(*) AS count FROM run_snapshots").get() as { count: number }).count),
      truncated,
      statuses,
      items,
    },
    events: {
      count: Number((db.query("SELECT COUNT(*) AS count FROM run_events").get() as { count: number }).count),
      byType,
    },
    outbox: {
      pending: outbox.find((row) => row.acknowledged === 0)?.count ?? 0,
      acknowledged: outbox.find((row) => row.acknowledged === 1)?.count ?? 0,
    },
    effects,
    diagnostics,
  };
}

/** Write a diagnostic export with restrictive file permissions. */
export async function writeDiagnosticExport(
  db: StoreDatabase,
  path: string,
  options: { readonly now?: number; readonly exportId?: string } = {},
): Promise<DiagnosticExport> {
  const report = createDiagnosticExport(db, options);
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return report;
}

function redactDiagnosticText(value: string): string {
  return sanitizeForProjection(value)
    .replace(/(?:[A-Za-z]:)?[\\/]\S+/g, "[PATH]")
    .replace(/\b(?:run|thread|command|effect|event|device|machine)[-_][A-Za-z0-9-]+\b/gi, "[ID]")
    .slice(0, MAX_MESSAGE_LENGTH);
}
