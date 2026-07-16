// Permission profiles — canonical, persisted per run.
// These define the technical confinement level; approval policy
// decides whether Relay may widen limits at runtime.

export type PermissionProfile = "read-only" | "workspace-write" | "full-access";

/** What a sandbox must enforce for each profile. */
export type SandboxPolicy = {
  readonly profile: PermissionProfile;
  readonly allowNetwork: boolean;
  readonly allowWriteOutsideWorktree: boolean;
  readonly allowEnvRead: boolean;
  readonly allowProcRead: boolean;
  readonly allowSymlinkEscape: boolean;
};

export const PROFILES: Readonly<Record<PermissionProfile, SandboxPolicy>> = {
  "read-only": {
    profile: "read-only",
    allowNetwork: false,
    allowWriteOutsideWorktree: false,
    allowEnvRead: false,
    allowProcRead: false,
    allowSymlinkEscape: false,
  },
  "workspace-write": {
    profile: "workspace-write",
    allowNetwork: false,
    allowWriteOutsideWorktree: false,
    allowEnvRead: false,
    allowProcRead: false,
    allowSymlinkEscape: false,
  },
  "full-access": {
    profile: "full-access",
    allowNetwork: true,
    allowWriteOutsideWorktree: true,
    allowEnvRead: true,
    allowProcRead: true,
    allowSymlinkEscape: true,
  },
};
