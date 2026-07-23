// ---------------------------------------------------------------------------
// Claim latency observability — wraps legacy work-claim gateway calls
// (conversations.claimQueuedMessage, subagents.claim, ...) to make claim
// duration, retries/rejections, and their causes observable, per the
// "Claim legacy work within self-hosted limits" ticket.
// ---------------------------------------------------------------------------

export type ClaimOutcome = "claimed" | "empty" | "error";

type ClaimSample = {
  readonly durationMs: number;
  readonly outcome: ClaimOutcome;
  readonly errorKind?: string;
};

const MAX_SAMPLES_PER_KIND = 500;
const samplesByKind = new Map<string, ClaimSample[]>();

export function recordClaimAttempt(kind: string, sample: ClaimSample): void {
  const list = samplesByKind.get(kind) ?? [];
  list.push(sample);
  if (list.length > MAX_SAMPLES_PER_KIND) list.shift();
  samplesByKind.set(kind, list);
}

/** Wrap a claim gateway call, timing it and classifying the outcome. */
export async function timedClaim<T>(
  kind: string,
  fn: () => Promise<T>,
  classify: (result: T) => ClaimOutcome,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    recordClaimAttempt(kind, { durationMs: Date.now() - start, outcome: classify(result) });
    return result;
  } catch (error) {
    recordClaimAttempt(kind, {
      durationMs: Date.now() - start,
      outcome: "error",
      errorKind: error instanceof Error ? error.constructor.name : "unknown",
    });
    throw error;
  }
}

/** Index into an ascending-sorted array at percentile `p` (0-1). Shared with `scripts/soak-legacy-claims.ts`. */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p));
  return sortedAsc[idx]!;
}

export type ClaimMetricsSnapshot = {
  readonly kind: string;
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly claimed: number;
  readonly empty: number;
  readonly errors: number;
  readonly errorKinds: Readonly<Record<string, number>>;
};

/** Observability snapshot per claim kind — count, percentiles, outcome breakdown, error causes. */
export function getClaimMetrics(): readonly ClaimMetricsSnapshot[] {
  const out: ClaimMetricsSnapshot[] = [];
  for (const [kind, samples] of samplesByKind) {
    const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b);
    const errorKinds: Record<string, number> = {};
    for (const s of samples) {
      if (s.outcome === "error" && s.errorKind) errorKinds[s.errorKind] = (errorKinds[s.errorKind] ?? 0) + 1;
    }
    out.push({
      kind,
      count: samples.length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      p99Ms: percentile(durations, 0.99),
      claimed: samples.filter((s) => s.outcome === "claimed").length,
      empty: samples.filter((s) => s.outcome === "empty").length,
      errors: samples.filter((s) => s.outcome === "error").length,
      errorKinds,
    });
  }
  return out;
}

/** Test-only: clear accumulated samples between test cases. */
export function resetClaimMetrics(): void {
  samplesByKind.clear();
}
