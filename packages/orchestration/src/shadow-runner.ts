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

export type ShadowEffect = {
  readonly effectId: string;
  readonly kind: string;
  readonly owner: "legacy" | "shadow";
};

/**
 * Runtime fence for shadow mode. Shadow can observe or record an effect
 * intent, but only the legacy owner may execute it. Replays of the exact
 * intent are idempotent; a changed intent with the same identity fails closed.
 */
export class ShadowEffectFence {
  readonly #effects = new Map<string, ShadowEffect>();

  record(effect: ShadowEffect): void {
    if (effect.owner !== "legacy") {
      throw new Error("Shadow effects must remain legacy-owned");
    }
    const existing = this.#effects.get(effect.effectId);
    if (existing) {
      if (existing.kind !== effect.kind || existing.owner !== effect.owner) {
        throw new Error(`Conflicting shadow effect ${effect.effectId}`);
      }
      return;
    }
    this.#effects.set(effect.effectId, effect);
  }

  get effects(): ReadonlyArray<ShadowEffect> {
    return [...this.#effects.values()];
  }
}

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
  const kernelState = canonicalSnapshotState(kernel);
  const legacyState = canonicalSnapshotState(legacy);
  if (kernelState !== legacyState) issues.push("Canonical snapshot state diverges");
  return issues;
}

function canonicalSnapshotState(snapshot: RunSnapshot): string {
  return canonicalPayload({
    activeTurnId: snapshot.activeTurnId,
    checkpoint: snapshot.checkpoint,
    permissionProfile: snapshot.permissionProfile,
    pendingApprovalId: snapshot.pendingApprovalId,
    projectId: snapshot.projectId,
    providerInstanceId: snapshot.providerInstanceId,
    providerSession: snapshot.providerSession,
    reducerPayload: snapshot.reducerPayload,
    restartCount: snapshot.restartCount,
    status: snapshot.status,
    workspace: snapshot.workspace,
  });
}

export function defaultEventComparator(
  kernelEvents: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>,
  legacyEvents: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>,
  options: { readonly allowFormatting?: boolean } = {},
): string[] {
  const issues: string[] = [];
  const comparable = (events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>) => events.filter((event) => isComparableEvent(event.type));
  const kernel = comparable(kernelEvents); const legacy = comparable(legacyEvents);
  if (kernel.length !== legacy.length) issues.push(`Comparable event count differs: kernel=${kernel.length}, legacy=${legacy.length}`);
  const count = Math.min(kernel.length, legacy.length);
  for (let i = 0; i < count; i++) {
    const left = kernel[i]!; const right = legacy[i]!;
    if (left.type !== right.type || left.turnId !== right.turnId) {
      issues.push(`Canonical event divergence at index ${i}: kernel=${left.type}/${left.turnId ?? ""}, legacy=${right.type}/${right.turnId ?? ""}`);
      continue;
    }
    if (canonicalPayload(left.payload) !== canonicalPayload(right.payload)) {
      const leftText = options.allowFormatting && left.type === "assistant.delta" ? normalizedText(left.payload) : canonicalPayload(left.payload);
      const rightText = options.allowFormatting && right.type === "assistant.delta" ? normalizedText(right.payload) : canonicalPayload(right.payload);
      if (leftText !== rightText) issues.push(`Canonical payload divergence at index ${i}: ${left.type}`);
    }
  }
  return issues;
}

function isComparableEvent(type: string): boolean {
  return [
    "run.created", "run.started", "run.stopping", "run.stopped", "run.failed",
    "provider.session.started", "provider.session.resumed", "provider.session.stopped",
    "turn.started", "turn.steered", "turn.completed", "turn.failed", "turn.interrupted",
    "assistant.delta", "assistant.completed",
    "activity.started", "activity.delta", "activity.completed", "activity.failed",
    "approval.requested", "approval.resolved", "usage.recorded",
    "checkpoint.captured", "checkpoint.restored", "checkpoint.compared", "workspace.diff.updated", "git.action.updated", "run.configuration.updated", "review.comment.created", "review.comment.resolved", "projection.published",
  ].includes(type);
}

function canonicalPayload(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return JSON.stringify(payload);
  const record = payload as Record<string, unknown>;
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (["eventId", "messageId", "createdAt", "updatedAt", "occurredAt"].includes(key)) continue;
    stable[key] = record[key];
  }
  return JSON.stringify(stable);
}

function normalizedText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return canonicalPayload(payload);
  const text = (payload as Record<string, unknown>).text;
  return typeof text === "string" ? text.trim().replace(/\s+/g, " ") : canonicalPayload(payload);
}

// ---------------------------------------------------------------------------
// Shadow persistence — records parity results with correlation evidence.
// ---------------------------------------------------------------------------

export type ShadowEvidence = {
  readonly correlationId: string;
  readonly runId: string;
  readonly timestamp: number;
  readonly parityReport: ParityReport;
  readonly kernelSnapshot: RunSnapshot;
  readonly legacySnapshot: RunSnapshot;
  readonly allowlistRefs: ReadonlyArray<string>;
};

/** In-memory shadow evidence store — persists divergence evidence for promotion gate checks. */
export class ShadowEvidenceStore {
  readonly #records: ShadowEvidence[] = [];

  record(evidence: ShadowEvidence): void {
    this.#records.push(evidence);
  }

  /** Restore previously persisted evidence before accepting new captures. */
  hydrate(evidence: ReadonlyArray<ShadowEvidence>): void {
    this.#records.push(...evidence);
  }

  /** Returns evidence where parity failed AND the divergence is not on the allowlist. */
  unexplainedDivergences(): ReadonlyArray<ShadowEvidence> {
    return this.#records.filter(
      (r) =>
        !r.parityReport.ok &&
        r.parityReport.divergences.some(
          (d) => !r.allowlistRefs.some((ref) => d.includes(ref)),
        ),
    );
  }

  /** Returns true if any unexplained divergence exists — blocks promotion. */
  promotionBlocked(): boolean {
    return this.unexplainedDivergences().length > 0;
  }

  /** Clear all records (called when shadow lifecycle resets). */
  clear(): void {
    this.#records.length = 0;
  }

  get records(): ReadonlyArray<ShadowEvidence> {
    return this.#records;
  }
}

/** Shadow supervisor — ensures single-effect ownership and no duplicate timers. */
export class ShadowSupervisor {
  #active = false;
  #timerId?: ReturnType<typeof setInterval>;

  start(onTick: () => void, intervalMs: number): void {
    if (this.#active) return;
    this.#active = true;
    this.#timerId = setInterval(() => {
      if (!this.#active) return;
      onTick();
    }, intervalMs);
  }

  stop(): void {
    this.#active = false;
    if (this.#timerId !== undefined) {
      clearInterval(this.#timerId);
      this.#timerId = undefined;
    }
  }

  get active(): boolean {
    return this.#active;
  }
}
