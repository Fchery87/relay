import type { PermissionProfile, SandboxPolicy, PROFILES } from "@relay/contracts";

// ---------------------------------------------------------------------------
// Sandbox executor — the single interface all commands route through.
// Platform-specific adapters implement this; the engine calls it.
// ---------------------------------------------------------------------------

export type SandboxConfig = {
  readonly worktreePath: string;
  readonly tempDir: string;
  readonly permissionProfile: PermissionProfile;
};

export type SandboxResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly sandboxed: boolean;
};

export interface SandboxExecutor {
  /** Execute a command under the configured sandbox policy.
   *  Must throw if the command violates the policy (escape attempts, forbidden access). */
  execute(
    command: string[],
    config: SandboxConfig,
  ): Promise<SandboxResult>;

  /** Whether this platform has sandbox enforcement available. */
  available(): boolean;
}

// ---------------------------------------------------------------------------
// Policy enforcement helpers (pure — platform-independent)
// ---------------------------------------------------------------------------

export function validateCommand(
  command: string[],
  profile: PermissionProfile,
): { allowed: boolean; reason?: string } {
  const policy = getPolicy(profile);

  // Detect escape attempts by command analysis
  const cmdStr = command.join(" ");

  // These patterns are always blocked for non-full-access profiles
  if (!policy.allowEnvRead && /(?:^|\s)(\.env|process\.env|\/proc\/\d+\/environ)/.test(cmdStr)) {
    return { allowed: false, reason: "env_read_blocked" };
  }
  if (!policy.allowSymlinkEscape && /readlink.*\.\./.test(cmdStr)) {
    return { allowed: false, reason: "symlink_escape_blocked" };
  }
  if (!policy.allowNetwork && /\b(curl|wget|nc |netcat|socket)\b/.test(cmdStr)) {
    return { allowed: false, reason: "network_blocked" };
  }

  return { allowed: true };
}

function getPolicy(profile: PermissionProfile): SandboxPolicy {
  // Inline the policy to avoid circular imports
  const policies: Record<PermissionProfile, SandboxPolicy> = {
    "read-only": { profile: "read-only", allowNetwork: false, allowWriteOutsideWorktree: false, allowEnvRead: false, allowProcRead: false, allowSymlinkEscape: false },
    "workspace-write": { profile: "workspace-write", allowNetwork: false, allowWriteOutsideWorktree: false, allowEnvRead: false, allowProcRead: false, allowSymlinkEscape: false },
    "full-access": { profile: "full-access", allowNetwork: true, allowWriteOutsideWorktree: true, allowEnvRead: true, allowProcRead: true, allowSymlinkEscape: true },
  };
  return policies[profile];
}
