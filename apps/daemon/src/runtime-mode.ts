export type RuntimeMode = "legacy" | "shadow" | "kernel";

const VALID_RUNTIME_MODES = new Set<string>(["legacy", "shadow", "kernel"]);

/** Canary state — reported during each heartbeat for telemetry. */
export type CanaryTelemetry = {
  mode: RuntimeMode;
  activeLeases: number;
  duplicateCommands: number;
  crossOwnerResults: number;
  pendingEffects: number;
  projectionBacklog: number;
  projectionGaps: number;
  projectionDivergences: number;
  authFailures: number;
  sandboxViolations: number;
  recoverableFailures: number;
  unrecoverableFailures: number;
  fallbackActivations: number;
};

/** Auto-rollback triggers — if any threshold is exceeded, kernel mode rolls back to legacy. */
export type RollbackThresholds = {
  readonly maxProjectionGaps: number;
  readonly maxProjectionDivergences: number;
  readonly maxCrossOwnerResults: number;
  readonly maxUnrecoverableFailures: number;
  readonly maxSandboxViolations: number;
};

export const DEFAULT_ROLLBACK_THRESHOLDS: RollbackThresholds = {
  maxProjectionGaps: 0,
  maxProjectionDivergences: 0,
  maxCrossOwnerResults: 0,
  maxUnrecoverableFailures: 0,
  maxSandboxViolations: 0,
};

export function canaryRollbackReason(
  telemetry: CanaryTelemetry,
  thresholds: RollbackThresholds = DEFAULT_ROLLBACK_THRESHOLDS,
): string | undefined {
  if (telemetry.projectionGaps > thresholds.maxProjectionGaps) return "projection-gap";
  if (telemetry.projectionDivergences > thresholds.maxProjectionDivergences) return "projection-divergence";
  if (telemetry.crossOwnerResults > thresholds.maxCrossOwnerResults) return "cross-owner-result";
  if (telemetry.unrecoverableFailures > thresholds.maxUnrecoverableFailures) return "unrecoverable-failure";
  if (telemetry.sandboxViolations > thresholds.maxSandboxViolations) return "sandbox-violation";
  return undefined;
}

/** Check whether canary telemetry triggers an automatic rollback to legacy. */
export function shouldRollback(
  telemetry: CanaryTelemetry,
  thresholds: RollbackThresholds = DEFAULT_ROLLBACK_THRESHOLDS,
): boolean {
  return canaryRollbackReason(telemetry, thresholds) !== undefined;
}

/**
 * Resolve the effective runtime mode.
 *
 * - If `RELAY_KERNEL_DISABLED=1`, any non-legacy mode is refused. This is a
 *   safety override that blocks accidental kernel/shadow enablement regardless
 *   of RELAY_RUNTIME_MODE.
 * - The default mode is `legacy`.
 */
export function resolveRuntimeMode(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeMode {
  const kernelDisabled = (env.RELAY_KERNEL_DISABLED ?? "").trim() === "1";
  const raw = (env.RELAY_RUNTIME_MODE ?? "legacy").trim();
  if (!VALID_RUNTIME_MODES.has(raw)) {
    throw new Error(
      `Invalid RELAY_RUNTIME_MODE: "${raw}". Expected one of: legacy, shadow, kernel.`,
    );
  }
  const resolved = raw as RuntimeMode;
  if (kernelDisabled && resolved !== "legacy") {
    throw new Error(
      `RELAY_KERNEL_DISABLED is set but RELAY_RUNTIME_MODE is "${raw}". ` +
      `Kernel and shadow modes are not available when the kernel kill switch is active. ` +
      `Unset RELAY_KERNEL_DISABLED or use RELAY_RUNTIME_MODE=legacy.`,
    );
  }
  return resolved;
}

export function resolveMaxConcurrentRuns(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env.RELAY_KERNEL_MAX_CONCURRENT_RUNS;
  if (raw == null) return 4;
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    throw new Error(
      `RELAY_KERNEL_MAX_CONCURRENT_RUNS must be a positive integer, got: "${raw}"`,
    );
  }
  const parsed = parseInt(trimmed, 10);
  if (parsed <= 0) {
    throw new Error(
      `RELAY_KERNEL_MAX_CONCURRENT_RUNS must be a positive integer, got: "${raw}"`,
    );
  }
  return parsed;
}
