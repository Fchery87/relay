// ---------------------------------------------------------------------------
// Legacy removal — the final contraction of the daemon codebase.
// Only compiled in when RELAY_NARROW=1 is set.
// ---------------------------------------------------------------------------

import type { RuntimeMode } from "./runtime-mode";

/**
 * Legacy modules that are removed during narrowing.
 * These are guarded by a compile-time flag: RELAY_NARROW=1 removes them.
 * Until then, they are conditionally loaded based on runtime mode.
 */

export const LEGACY_MODULES = [
  "agent-loop.ts         — raw LLM provider loop (replaced by orchestration engine)",
  "command-worker.ts     — per-work-type command poller (replaced by Convex command inbox)",
  "checkpoint-worker.ts  — per-work-type checkpoint poller (replaced by checkpoint reactor)",
  "checkpoint-comparison-worker.ts — per-work-type comparison poller (replaced by shadow runner)",
  "git-worker.ts         — per-work-type git action poller (replaced by workspace reactor)",
  "subagent-worker.ts    — per-work-type subagent poller (replaced by orchestrated subagent workflow)",
] as const;

/**
 * Conditionally load legacy modules based on runtime mode.
 * When RELAY_NARROW=1 is set at build time, these are tree-shaken out.
 */
export function shouldLoadLegacy(mode: RuntimeMode): boolean {
  // When RELAY_NARROW is set, legacy modules are never loaded.
  if (typeof process !== "undefined" && (process.env as Record<string, string>).RELAY_NARROW === "1") {
    return false;
  }
  return mode === "legacy" || mode === "shadow";
}

/**
 * Guard: verify that all narrow preconditions are met before allowing removal.
 * Called before the irreversible narrow commit.
 */
export type NarrowPreconditions = {
  readonly kernelDefaultSince: number; // unix ms
  readonly zeroLegacyActivations: boolean;
  readonly backupRehearsalHash: string;
  readonly acceptanceTestPassed: boolean;
};

export function verifyNarrowPreconditions(
  pre: NarrowPreconditions,
): { ok: true } | { ok: false; reason: string } {
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - pre.kernelDefaultSince < oneWeek) {
    return { ok: false, reason: "Less than one release window on kernel-default" };
  }
  if (!pre.zeroLegacyActivations) {
    return { ok: false, reason: "Legacy activations still recorded" };
  }
  if (!pre.backupRehearsalHash) {
    return { ok: false, reason: "Backup rehearsal not verified" };
  }
  if (!pre.acceptanceTestPassed) {
    return { ok: false, reason: "Acceptance test not passed" };
  }
  return { ok: true };
}
