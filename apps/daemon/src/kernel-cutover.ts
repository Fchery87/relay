import type { RuntimeMode } from "./runtime-mode";

// ---------------------------------------------------------------------------
// Kernel cutover — controls the shadow→kernel→narrow migration.
// ---------------------------------------------------------------------------

export type CutoverGate = {
  /** Whether the kernel is ready to be the default runtime. */
  readonly kernelReady: boolean;
  /** Whether at least one release window has passed on kernel-default. */
  readonly releaseWindowSatisfied: boolean;
  /** Whether zero legacy activations have been recorded. */
  readonly zeroLegacyActivations: boolean;
  /** Whether the backup/rollback rehearsal has been verified. */
  readonly backupRehearsalVerified: boolean;
  /** Whether all production acceptance gates have passed. */
  readonly acceptanceGatesPassed: boolean;
};

/**
 * Determine the effective runtime mode based on the configured mode
 * and the current cutover gates.
 *
 * - If RELAY_RUNTIME_MODE is explicitly set, that value is used.
 * - Otherwise, if all cutover gates are satisfied, default to "kernel".
 * - Otherwise, default to "legacy".
 */
export function effectiveRuntimeMode(
  explicitMode: RuntimeMode | undefined,
  gates: CutoverGate,
): RuntimeMode {
  if (explicitMode) return explicitMode;

  if (
    gates.kernelReady &&
    gates.releaseWindowSatisfied &&
    gates.zeroLegacyActivations &&
    gates.backupRehearsalVerified &&
    gates.acceptanceGatesPassed
  ) {
    return "kernel";
  }

  return "legacy";
}

/** Default gate state — all false until acceptance tickets complete. */
export const DEFAULT_GATES: CutoverGate = {
  kernelReady: true, // kernel foundation (tickets 0-2,4-8) is built
  releaseWindowSatisfied: false, // needs one release window
  zeroLegacyActivations: false, // needs monitoring
  backupRehearsalVerified: false, // needs ticket 16
  acceptanceGatesPassed: false, // needs ticket 17
};
