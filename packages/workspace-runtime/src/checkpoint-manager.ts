import type { StoreDatabase } from "@relay/local-store";
import type { CheckpointId } from "@relay/contracts";

// ---------------------------------------------------------------------------
// Checkpoint manager — idempotent capture, restore-not-destroy.
// Checkpoints use hidden refs: refs/relay/checkpoints/<run>/<turn>
// ---------------------------------------------------------------------------

export type CheckpointRecord = {
  readonly checkpointId: CheckpointId;
  readonly runId: string;
  readonly turnId: string;
  readonly commit: string;
  readonly ref: string;
  readonly createdAt: number;
  /** Whether this checkpoint has been garbage-collected. */
  readonly gc?: boolean;
};

export type CheckpointInput = {
  readonly runId: string;
  readonly turnId: string;
  readonly commit: string;
};

export class CheckpointManager {
  constructor(private readonly db: StoreDatabase) {}

  /** Idempotent capture — if a checkpoint already exists for this turn, return it. */
  capture(input: CheckpointInput & { readonly ref: string }): CheckpointRecord {
    // Check for existing
    const existing = this.db
      .query("SELECT checkpoint_id FROM checkpoints WHERE run_id = ? AND turn_id = ?")
      .get(input.runId, input.turnId) as { checkpoint_id: string } | undefined;

    if (existing) {
      return this.get(existing.checkpoint_id)!;
    }

    const id = `ck-${input.runId}-${input.turnId}` as CheckpointId;
    this.db.run(
      `INSERT INTO checkpoints (checkpoint_id, run_id, turn_id, commit_sha, ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.runId, input.turnId, input.commit, input.ref, Date.now()],
    );
    return this.get(id as string)!;
  }

  /** Restore a checkpoint (restore-not-destroy semantics). */
  restore(checkpointId: string): CheckpointRecord | undefined {
    const record = this.get(checkpointId);
    if (!record) return undefined;
    // Restore is a logical operation; the actual git restore happens outside
    return record;
  }

  /** Get a specific checkpoint. */
  get(checkpointId: string): CheckpointRecord | undefined {
    const row = this.db
      .query("SELECT * FROM checkpoints WHERE checkpoint_id = ?")
      .get(checkpointId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      checkpointId: row.checkpoint_id as CheckpointId,
      runId: row.run_id as string,
      turnId: row.turn_id as string,
      commit: row.commit_sha as string,
      ref: row.ref as string,
      createdAt: row.created_at as number,
      gc: row.gc as boolean | undefined,
    };
  }

  /** List checkpoints for a run, ordered by creation time. */
  list(runId: string): CheckpointRecord[] {
    const rows = this.db
      .query("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      checkpointId: row.checkpoint_id as CheckpointId,
      runId: row.run_id as string,
      turnId: row.turn_id as string,
      commit: row.commit_sha as string,
      ref: row.ref as string,
      createdAt: row.created_at as number,
      gc: row.gc as boolean | undefined,
    }));
  }

  /** Mark a checkpoint for garbage collection. */
  markGc(checkpointId: string): void {
    this.db.run("UPDATE checkpoints SET gc = 1 WHERE checkpoint_id = ?", [checkpointId]);
  }
}
