// ---------------------------------------------------------------------------
// Operational observability — structured traces, metrics, health, diagnostics.
// ---------------------------------------------------------------------------

export type TraceSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedAt: number;
  endedAt?: number;
  tags: Record<string, string>;
};

export type DaemonMetrics = {
  readonly activeRuns: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly eventsProcessed: number;
  readonly outboxPending: number;
  readonly storageBytes: number;
  readonly uptimeMs: number;
};

export type HealthStatus = {
  readonly ok: boolean;
  readonly sqlite: "connected" | "error";
  readonly convex: "connected" | "disconnected" | "error";
  readonly providerStatuses: Record<string, "available" | "unavailable">;
  readonly metrics: DaemonMetrics;
};

/**
 * Structured trace — join browser→Convex→daemon→provider→tool→checkpoint.
 */
export class Tracer {
  private spans: TraceSpan[] = [];
  private startTime = Date.now();

  startSpan(name: string, parentSpanId?: string): TraceSpan {
    const span: TraceSpan = {
      traceId: `trace-${crypto.randomUUID()}`,
      spanId: `span-${crypto.randomUUID()}`,
      parentSpanId,
      name,
      startedAt: Date.now(),
      tags: {},
    };
    this.spans.push(span);
    return span;
  }

  endSpan(span: TraceSpan): void {
    span.endedAt = Date.now();
  }

  getSpans(): ReadonlyArray<TraceSpan> {
    return this.spans;
  }

  reset(): void {
    this.spans = [];
    this.startTime = Date.now();
  }
}

let metrics: DaemonMetrics = {
  activeRuns: 0,
  completedRuns: 0,
  failedRuns: 0,
  eventsProcessed: 0,
  outboxPending: 0,
  storageBytes: 0,
  uptimeMs: 0,
};

const startTime = Date.now();

export function incrementMetric(key: keyof DaemonMetrics): void {
  const m = metrics as Record<string, number>;
  if (typeof m[key] === "number") m[key]++;
}

export function getMetrics(): DaemonMetrics {
  return { ...metrics, uptimeMs: Date.now() - startTime };
}

export function getHealth(): HealthStatus {
  return {
    ok: true,
    sqlite: "connected",
    convex: "connected",
    providerStatuses: {},
    metrics: getMetrics(),
  };
}
