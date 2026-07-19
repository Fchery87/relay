import type {
  CommandId,
  DurableEffect,
  EffectFailureKind,
  EffectId,
  EffectIntent,
  EffectRetryClass,
  RunId,
} from "@relay/contracts";
import type { StoreDatabase } from "./database";
import { PersistedRecordError } from "./persistence-codecs";

export type EffectDraft = {
  readonly effectId: EffectId;
  readonly runId: RunId;
  readonly commandId: CommandId;
  readonly effectIndex: number;
  readonly intent: EffectIntent;
  readonly retryClass: EffectRetryClass;
};

export class EffectLeaseLostError extends Error {
  constructor(effectId: string, action: string) {
    super(`Effect lease was lost before ${action}: ${effectId}`);
    this.name = "EffectLeaseLostError";
  }
}

export function insertEffect(
  db: StoreDatabase,
  effect: EffectDraft,
  now: number,
): void {
  db.run(
    `INSERT INTO effect_outbox (
      effect_id, run_id, command_id, effect_index, kind, payload_json,
      status, attempts, retry_class, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, 0, ?, ?)`,
    [
      effect.effectId,
      effect.runId,
      effect.commandId,
      effect.effectIndex,
      effect.intent.kind,
      encodeIntent(effect.intent),
      effect.retryClass,
      now,
      now,
    ],
  );
}

export function claimEffectBatch(
  db: StoreDatabase,
  owner: string,
  leaseMs: number,
  limit: number,
  now = Date.now(),
): ReadonlyArray<DurableEffect> {
  if (!owner) throw new Error("Effect lease owner is required");
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Effect claim limit must be a positive integer");
  }
  if (!Number.isFinite(leaseMs) || leaseMs < 1) {
    throw new Error("Effect lease must be positive");
  }

  return db.transaction(() => {
    const candidates = db
      .query(
        `SELECT candidate.effect_id FROM effect_outbox AS candidate
         WHERE (
              (
                candidate.status = 'pending'
                AND candidate.next_attempt_at <= ?
              )
            OR (
              candidate.status = 'running'
              AND candidate.lease_expires_at <= ?
            )
           )
           AND NOT EXISTS (
             SELECT 1 FROM effect_outbox AS earlier
             WHERE earlier.run_id = candidate.run_id
               AND earlier.rowid < candidate.rowid
               AND earlier.status IN ('pending', 'running')
           )
         ORDER BY candidate.rowid ASC
         LIMIT ?`,
      )
      .all(now, now, limit) as Array<{ effect_id: string }>;
    if (candidates.length === 0) return [];

    const leaseExpiresAt = now + leaseMs;
    for (const { effect_id } of candidates) {
      db.run(
        `UPDATE effect_outbox
         SET status = 'running',
             attempts = CASE
               WHEN status = 'running' AND retry_class = 'never'
                 THEN attempts
               ELSE attempts + 1
             END,
             last_error = CASE
               WHEN status = 'running' AND retry_class = 'never'
                 THEN ?
               ELSE last_error
             END,
             last_error_kind = CASE
               WHEN status = 'running' AND retry_class = 'never'
                 THEN 'terminal'
               ELSE last_error_kind
             END,
             next_attempt_at = 0,
             lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE effect_id = ?
           AND (status = 'pending'
             OR (status = 'running' AND lease_expires_at <= ?))`,
        [
          NON_RETRYABLE_LEASE_FAILURE,
          owner,
          leaseExpiresAt,
          now,
          effect_id,
          now,
        ],
      );
    }

    return candidates.flatMap(({ effect_id }) => {
      const row = db
        .query("SELECT * FROM effect_outbox WHERE effect_id = ? AND lease_owner = ?")
        .get(effect_id, owner) as EffectRow | undefined;
      return row ? [rowToEffect(row)] : [];
    });
  })();
}

export function completeEffect(
  db: StoreDatabase,
  effectId: EffectId,
  owner: string,
  now = Date.now(),
): void {
  const result = db.run(
    `UPDATE effect_outbox
     SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
         last_error = NULL, last_error_kind = NULL, next_attempt_at = 0,
         failed_at = NULL, updated_at = ?
     WHERE effect_id = ? AND status = 'running' AND lease_owner = ?`,
    [now, effectId, owner],
  );
  if (result.changes !== 1) {
    throw new EffectLeaseLostError(effectId, "completion");
  }
}

export function renewEffectLease(
  db: StoreDatabase,
  effectId: EffectId,
  owner: string,
  leaseMs: number,
  now = Date.now(),
): boolean {
  const result = db.run(
    `UPDATE effect_outbox
     SET lease_expires_at = ?, updated_at = ?
     WHERE effect_id = ? AND status = 'running' AND lease_owner = ?`,
    [now + leaseMs, now, effectId, owner],
  );
  return result.changes === 1;
}

export type ReleaseEffectInput = {
  readonly effectId: EffectId;
  readonly owner: string;
  readonly error: string;
  readonly errorKind: EffectFailureKind;
  readonly terminal: boolean;
  readonly nextAttemptAt?: number;
  readonly now?: number;
};

export function releaseEffect(
  db: StoreDatabase,
  input: ReleaseEffectInput,
): void {
  const now = input.now ?? Date.now();
  const nextAttemptAt = input.terminal ? 0 : (input.nextAttemptAt ?? now);
  const result = db.run(
    `UPDATE effect_outbox
     SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
         last_error = ?, last_error_kind = ?, next_attempt_at = ?,
         failed_at = ?, updated_at = ?
     WHERE effect_id = ? AND status = 'running' AND lease_owner = ?`,
    [
      input.terminal ? "failed" : "pending",
      input.error,
      input.errorKind,
      nextAttemptAt,
      input.terminal ? now : null,
      now,
      input.effectId,
      input.owner,
    ],
  );
  if (result.changes !== 1) {
    throw new EffectLeaseLostError(input.effectId, "release");
  }
}

export function fenceEffectForFailureRecovery(
  db: StoreDatabase,
  effectId: EffectId,
  owner: string,
  error: string,
  now = Date.now(),
): void {
  const result = db.run(
    `UPDATE effect_outbox
     SET retry_class = 'never', last_error = ?, updated_at = ?
     WHERE effect_id = ? AND status = 'running' AND lease_owner = ?`,
    [error, now, effectId, owner],
  );
  if (result.changes !== 1) {
    throw new EffectLeaseLostError(effectId, "failure fencing");
  }
}

export function getEffectsForCommand(
  db: StoreDatabase,
  commandId: CommandId,
): ReadonlyArray<DurableEffect> {
  const rows = db
    .query(
      "SELECT * FROM effect_outbox WHERE command_id = ? ORDER BY effect_index",
    )
    .all(commandId) as EffectRow[];
  return rows.map(rowToEffect);
}

export function getNextEffectClaimAt(
  db: StoreDatabase,
): number | undefined {
  const row = db
    .query(
      `SELECT MIN(
         CASE
           WHEN candidate.status = 'pending' THEN candidate.next_attempt_at
           ELSE candidate.lease_expires_at
         END
       ) AS claim_at
       FROM effect_outbox AS candidate
       WHERE candidate.status IN ('pending', 'running')
         AND NOT EXISTS (
           SELECT 1 FROM effect_outbox AS earlier
           WHERE earlier.run_id = candidate.run_id
             AND earlier.rowid < candidate.rowid
             AND earlier.status IN ('pending', 'running')
         )`,
    )
    .get() as { claim_at: number | null };
  return row.claim_at ?? undefined;
}

function encodeIntent(intent: EffectIntent): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "effect_intent",
    data: intent,
  });
}

function decodeIntent(json: string, expectedKind: string): EffectIntent {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new PersistedRecordError("Invalid JSON in persisted effect intent");
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "effect_intent" ||
    !isRecord(value.data) ||
    value.data.kind !== expectedKind
  ) {
    throw new PersistedRecordError("Invalid persisted effect intent");
  }
  return value.data as EffectIntent;
}

function rowToEffect(row: EffectRow): DurableEffect {
  if (
    row.status !== "pending" &&
    row.status !== "running" &&
    row.status !== "completed" &&
    row.status !== "failed"
  ) {
    throw new PersistedRecordError(`Invalid effect status: ${row.status}`);
  }
  if (
    row.retry_class !== "never" &&
    row.retry_class !== "transient" &&
    row.retry_class !== "rate_limited"
  ) {
    throw new PersistedRecordError(
      `Invalid effect retry class: ${row.retry_class}`,
    );
  }
  if (
    row.last_error_kind !== null &&
    row.last_error_kind !== "retryable" &&
    row.last_error_kind !== "rate_limited" &&
    row.last_error_kind !== "approval_required" &&
    row.last_error_kind !== "terminal"
  ) {
    throw new PersistedRecordError(
      `Invalid effect failure kind: ${row.last_error_kind}`,
    );
  }
  if (!Number.isSafeInteger(row.next_attempt_at) || row.next_attempt_at < 0) {
    throw new PersistedRecordError("Invalid effect next attempt time");
  }
  return {
    effectId: row.effect_id as never,
    idempotencyKey: row.effect_id as never,
    runId: row.run_id as never,
    commandId: row.command_id as never,
    effectIndex: row.effect_index,
    intent: decodeIntent(row.payload_json, row.kind),
    status: row.status,
    attempts: row.attempts,
    retryClass: row.retry_class,
    nextAttemptAt: row.next_attempt_at,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null
      ? {}
      : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    ...(row.last_error_kind === null
      ? {}
      : { lastErrorKind: row.last_error_kind }),
    ...(row.failed_at === null ? {} : { failedAt: row.failed_at }),
    ...(row.retry_class === "never" &&
    row.last_error === NON_RETRYABLE_LEASE_FAILURE
      ? { recoveryFailure: NON_RETRYABLE_LEASE_FAILURE }
      : {}),
  };
}

type EffectRow = {
  effect_id: string;
  run_id: string;
  command_id: string;
  effect_index: number;
  kind: string;
  payload_json: string;
  status: string;
  attempts: number;
  retry_class: string;
  next_attempt_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  last_error_kind: EffectFailureKind | null;
  failed_at: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NON_RETRYABLE_LEASE_FAILURE =
  "Non-retryable effect lease expired";
