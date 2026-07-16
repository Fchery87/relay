import type { RunSnapshot, EventEnvelope, CanonicalEventType } from "@relay/contracts";

// ---------------------------------------------------------------------------
// Shadow runner — compares kernel projections against legacy results
// without dual-executing side effects. Used in shadow mode to prove parity.
// ---------------------------------------------------------------------------

export type ParityReport = {
  readonly runId: string;
  readonly ok: boolean;
  readonly divergences: ReadonlyArray<string>;
  readonly kernelSequence: number;
  readonly legacySequence: number;
};

export type ShadowConfig = {
  /** Compare kernel and legacy snapshots for a run. Returns divergences. */
  compareSnapshots(
    kernel: RunSnapshot,
    legacy: RunSnapshot,
  ): ReadonlyArray<string>;

  /** Compare kernel and legacy event sequences. */
  compareEvents(
    kernelEvents: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>,
    legacyEvents: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>,
  ): ReadonlyArray<string>;
};

export class ShadowRunner {
  constructor(private readonly config: ShadowConfig) {}

  /**
   * Run a parity check between kernel and legacy for a single run.
   * Does NOT dual-execute: compares projections only, no second provider turn.
   */
  run(
    kernelSnap: RunSnapshot,
    legacySnap: RunSnapshot,
    kernelEvents: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>,
    legacyEvents: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>,
  ): ParityReport {
    const divergences: string[] = [];

    divergences.push(...this.config.compareSnapshots(kernelSnap, legacySnap));
    divergences.push(...this.config.compareEvents(kernelEvents, legacyEvents));

    return {
      runId: kernelSnap.runId as string,
      ok: divergences.length === 0,
      divergences,
      kernelSequence: kernelSnap.sequence,
      legacySequence: legacySnap.sequence,
    };
  }
}

// ---------------------------------------------------------------------------
// Default comparators
// ---------------------------------------------------------------------------

export function defaultSnapshotComparator(
  kernel: RunSnapshot,
  legacy: RunSnapshot,
): string[] {
  const issues: string[] = [];
  if (kernel.status !== legacy.status) {
    issues.push(`Status: kernel=${kernel.status}, legacy=${legacy.status}`);
  }
  // Kernel may have more events (canonical model adds detail) — only flag
  // if the kernel has FEWER events for the same operations.
  if (kernel.sequence < legacy.sequence) {
    issues.push(
      `Sequence: kernel=${kernel.sequence} < legacy=${legacy.sequence}`,
    );
  }
  return issues;
}

export function defaultEventComparator(
  kernelEvents: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>,
  legacyEvents: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>,
): string[] {
  const issues: string[] = [];
  // Compare event counts
  if (kernelEvents.length === 0 && legacyEvents.length > 0) {
    issues.push("Kernel produced 0 events while legacy produced events");
  }
  // Check for missing critical event types in kernel
  const kernelTypes = new Set(kernelEvents.map((e) => e.type));
  const legacyTypes = new Set(legacyEvents.map((e) => e.type));
  for (const lt of legacyTypes) {
    if (!kernelTypes.has(lt) && isCriticalEvent(lt)) {
      issues.push(`Critical event "${lt}" missing from kernel stream`);
    }
  }
  return issues;
}

function isCriticalEvent(type: string): boolean {
  return ["turn.started", "turn.completed", "assistant.delta"].includes(type);
}
