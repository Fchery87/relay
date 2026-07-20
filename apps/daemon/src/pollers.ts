/**
 * Even out claim-poller phases so the daemon's pollers don't all fire in the
 * same instant. The self-hosted Convex backend serializes mutation execution;
 * when every poller bursts together, the mutations pile up and exceed the hard
 * 1s function limit on low-power hardware. Spreading their start phases across
 * one interval keeps roughly one poll in flight at a time.
 *
 * This is phase only — each poller still runs exactly once per `intervalMs`,
 * so no Relay behavior, ordering, or latency budget changes.
 */

/** Start offset (ms) for poller `index` of `count`, spread evenly across `intervalMs`. */
export function staggerOffset(index: number, count: number, intervalMs: number): number {
  if (count <= 1 || intervalMs <= 0) return 0;
  const slot = ((index % count) + count) % count;
  return Math.round((slot / count) * intervalMs);
}

/**
 * Run `tick` every `intervalMs`, with the first run delayed by `offsetMs`.
 * Returns a stop function that cancels the pending start and the interval.
 */
export function startStaggeredPoller(tick: () => void, intervalMs: number, offsetMs: number): () => void {
  let interval: ReturnType<typeof setInterval> | undefined;
  const starter = setTimeout(() => {
    tick();
    interval = setInterval(tick, intervalMs);
  }, Math.max(0, offsetMs));
  return () => {
    clearTimeout(starter);
    if (interval) clearInterval(interval);
  };
}
