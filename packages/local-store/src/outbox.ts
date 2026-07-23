import type { StoreDatabase } from "./database";

export type OutboxRow = {
  id: number;
  eventId: string;
  runId: string;
  sequence: number;
  type: string;
  payloadJson: string;
  occurredAt: number;
};

/**
 * Claim a bounded batch of unpublished outbox rows under a lease.
 * Rows already leased (and not expired) are skipped.
 */
export function claimOutboxBatch(
  db: StoreDatabase,
  owner: string,
  leaseDurationMs: number,
  limit: number,
): OutboxRow[] {
  const now = Date.now();
  const expiresAt = now + leaseDurationMs;

  const rows = db.transaction((): OutboxRow[] => {
    // Claim rows that are unacknowledged and either unleased or lease expired
    const candidates = db
      .query(
        `SELECT id, event_id, run_id, sequence, type, payload_json, occurred_at
         FROM projection_outbox
         WHERE acknowledged = 0
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(now, limit) as Array<{
      id: number;
      event_id: string;
      run_id: string;
      sequence: number;
      type: string;
      payload_json: string;
      occurred_at: number;
    }>;

    if (candidates.length === 0) return [];

    const ids = candidates.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    db.run(
      `UPDATE projection_outbox SET lease_owner = ?, lease_expires_at = ? WHERE id IN (${placeholders})`,
      [owner, expiresAt, ...ids],
    );

    return candidates.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      runId: r.run_id,
      sequence: r.sequence,
      type: r.type,
      payloadJson: r.payload_json,
      occurredAt: r.occurred_at,
    }));
  })();

  return rows;
}

/**
 * Acknowledge a batch of outbox rows (mark as published).
 */
export function acknowledgeOutboxBatch(
  db: StoreDatabase,
  ids: readonly number[],
): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.run(
    `UPDATE projection_outbox SET acknowledged = 1 WHERE id IN (${placeholders})`,
    [...ids],
  );
}

/** Count unacknowledged outbox rows and the age of the oldest one, for backlog observability. */
export function countPendingOutbox(
  db: StoreDatabase,
): { count: number; oldestOccurredAt: number | null; maxId: number | null } {
  const row = db
    .query(
      `SELECT COUNT(*) as count, MIN(occurred_at) as oldest, MAX(id) as maxId
       FROM projection_outbox WHERE acknowledged = 0`,
    )
    .get() as { count: number; oldest: number | null; maxId: number | null };
  return { count: row.count, oldestOccurredAt: row.oldest, maxId: row.maxId };
}
