import type { StoreDatabase } from "@relay/local-store";
import type { RunId, WorkspaceRecord, PermissionProfile } from "@relay/contracts";

// ---------------------------------------------------------------------------
// Workspace manager — owns durable workspace records in the local store.
// Reconciles with git worktree state on startup.
// ---------------------------------------------------------------------------

export type ReconciledWorkspace = {
  readonly record: WorkspaceRecord;
  /** Safe: record matches git. Unsafe: discrepancy needs manual intervention. */
  readonly healthy: boolean;
  readonly gitWorktreePath?: string;
  readonly gitHead?: string;
};

export type WorkspaceInput = {
  readonly runId: RunId;
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly permissionProfile?: PermissionProfile;
};

export class WorkspaceManager {
  constructor(private readonly db: StoreDatabase) {}

  /** Persist a workspace record. */
  create(input: WorkspaceInput): WorkspaceRecord {
    const record: WorkspaceRecord = {
      runId: input.runId,
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      baseCommit: input.baseCommit,
      permissionProfile: input.permissionProfile ?? "workspace-write",
      createdAt: Date.now(),
    };
    this.db.run(
      `INSERT INTO workspaces (run_id, repo_path, worktree_path, base_commit, permission_profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [record.runId, record.repoPath, record.worktreePath, record.baseCommit, record.permissionProfile, record.createdAt],
    );
    return record;
  }

  /** Get a workspace by run ID. */
  get(runId: string): WorkspaceRecord | undefined {
    const row = this.db
      .query("SELECT * FROM workspaces WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id as RunId,
      repoPath: row.repo_path as string,
      worktreePath: row.worktree_path as string,
      baseCommit: row.base_commit as string,
      permissionProfile: row.permission_profile as PermissionProfile,
      createdAt: row.created_at as number,
      cleanedUp: row.cleaned_up as boolean | undefined,
    };
  }

  /** Mark a workspace as cleaned up. */
  markCleanedUp(runId: string): void {
    this.db.run("UPDATE workspaces SET cleaned_up = 1 WHERE run_id = ?", [runId]);
  }

  /**
   * Reconcile stored records against git-worktree state.
   * In a real implementation this would shell out to `git worktree list --porcelain`.
   * For now, return records as-is with a healthy flag.
   */
  reconcile(/* gitWorktreeListOutput?: string */): ReconciledWorkspace[] {
    const rows = this.db.query("SELECT * FROM workspaces WHERE cleaned_up IS NULL OR cleaned_up = 0").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      record: {
        runId: row.run_id as RunId,
        repoPath: row.repo_path as string,
        worktreePath: row.worktree_path as string,
        baseCommit: row.base_commit as string,
        permissionProfile: row.permission_profile as PermissionProfile,
        createdAt: row.created_at as number,
        cleanedUp: row.cleaned_up as boolean | undefined,
      },
      healthy: true,
    }));
  }
}
