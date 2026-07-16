// ---------------------------------------------------------------------------
// Service-level objectives and load profiles.
// ---------------------------------------------------------------------------

export type ServiceLevelObjective = {
  readonly name: string;
  readonly target: number;
  readonly unit: string;
  readonly measured?: number;
};

export const SLO_DEFINITIONS: ReadonlyArray<ServiceLevelObjective> = [
  {
    name: "prompt-to-first-token-latency",
    target: 200,
    unit: "ms",
  },
  {
    name: "command-output-chunk-latency",
    target: 200,
    unit: "ms",
  },
  {
    name: "event-append-throughput",
    target: 1000,
    unit: "events/s",
  },
  {
    name: "projection-sync-latency",
    target: 500,
    unit: "ms",
  },
  {
    name: "daemon-startup-time",
    target: 2000,
    unit: "ms",
  },
  {
    name: "restart-recovery-time",
    target: 5000,
    unit: "ms",
  },
  {
    name: "max-concurrent-runs",
    target: 4,
    unit: "runs",
  },
  {
    name: "sqlite-write-latency-p99",
    target: 10,
    unit: "ms",
  },
];

export type LoadProfile = {
  readonly name: string;
  readonly concurrentRuns: number;
  readonly turnsPerRun: number;
  readonly eventsPerTurn: number;
  readonly durationMs: number;
};

export const LOAD_PROFILES: ReadonlyArray<LoadProfile> = [
  {
    name: "idle",
    concurrentRuns: 0,
    turnsPerRun: 0,
    eventsPerTurn: 0,
    durationMs: 60_000,
  },
  {
    name: "single-run",
    concurrentRuns: 1,
    turnsPerRun: 5,
    eventsPerTurn: 20,
    durationMs: 300_000,
  },
  {
    name: "production-typical",
    concurrentRuns: 4,
    turnsPerRun: 10,
    eventsPerTurn: 50,
    durationMs: 600_000,
  },
  {
    name: "stress",
    concurrentRuns: 8,
    turnsPerRun: 20,
    eventsPerTurn: 100,
    durationMs: 300_000,
  },
];

// ---------------------------------------------------------------------------
// Narrow procedure — the final, irreversible contraction step.
// Removes legacy code and widens schemas after all gates pass.
// ---------------------------------------------------------------------------

export type NarrowGate = {
  readonly kernelDefault: boolean;
  readonly releaseWindowPassed: boolean;
  readonly zeroLegacyActivations: boolean;
  readonly backupRehearsalDone: boolean;
  readonly acceptancePassed: boolean;
};

/**
 * Determine whether narrowing is safe to proceed.
 * ALL gates must be true — this is irreversible.
 */
export function canNarrow(gate: NarrowGate): boolean {
  return (
    gate.kernelDefault &&
    gate.releaseWindowPassed &&
    gate.zeroLegacyActivations &&
    gate.backupRehearsalDone &&
    gate.acceptancePassed
  );
}

/** Items to remove during narrowing. */
export const NARROW_CHECKLIST: ReadonlyArray<string> = [
  "Remove legacy agent-loop.ts and raw-llm model provider",
  "Remove per-work-type pollers: command-worker.ts, checkpoint-worker.ts, git-worker.ts, subagent-worker.ts, checkpoint-comparison-worker.ts",
  "Remove RELAY_RUNTIME_MODE flag and kernel-cutover gating",
  "Drop dual-write columns from legacy Convex tables (threads.projectionImported, etc.)",
  "Drop unused v1 tables if no longer referenced (with verified backup)",
  "Remove width-only migration compatibility code",
  "Record release evidence: dry-run logs, verification output, rehearsal results",
];
