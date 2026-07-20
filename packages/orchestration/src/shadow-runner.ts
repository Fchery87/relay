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
  const comparable = (events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>) => events.filter((event) => isCriticalEvent(event.type));
  const kernel = comparable(kernelEvents); const legacy = comparable(legacyEvents);
  if (kernel.length !== legacy.length) issues.push(`Critical event count differs: kernel=${kernel.length}, legacy=${legacy.length}`);
  const count = Math.min(kernel.length, legacy.length);
  for (let i = 0; i < count; i++) {
    const left = kernel[i]!; const right = legacy[i]!;
    if (left.type !== right.type || left.turnId !== right.turnId) issues.push(`Critical event divergence at index ${i}: kernel=${left.type}/${left.turnId ?? ""}, legacy=${right.type}/${right.turnId ?? ""}`);
  }
  return issues;
}

function isCriticalEvent(type: string): boolean {
  return ["turn.started", "turn.completed", "assistant.delta"].includes(type);
}
