import type { RunId } from "./ids";
import type { PermissionProfile } from "./permissions";

export type WorkspaceRecord = {
  readonly runId: RunId;
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly permissionProfile: PermissionProfile;
  readonly createdAt: number;
  /** If the worktree has been cleaned up. */
  readonly cleanedUp?: boolean;
};
