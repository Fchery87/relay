import { expect, test } from "bun:test";

import { staggerOffset, startStaggeredPoller } from "./pollers";

test("spreads pollers evenly across the interval", () => {
  const count = 7;
  const interval = 3000;
  const offsets = Array.from({ length: count }, (_, i) => staggerOffset(i, count, interval));
  expect(offsets[0]).toBe(0);
  // Strictly increasing and all within one interval.
  for (let i = 1; i < count; i++) {
    expect(offsets[i]).toBeGreaterThan(offsets[i - 1]!);
    expect(offsets[i]).toBeLessThan(interval);
  }
  // Even spacing (±1ms for integer rounding): no two adjacent pollers cluster.
  const spacing = interval / count;
  for (let i = 1; i < count; i++) {
    expect(Math.abs(offsets[i]! - offsets[i - 1]! - spacing)).toBeLessThanOrEqual(1);
  }
});

test("degenerate inputs return a zero offset", () => {
  expect(staggerOffset(0, 1, 3000)).toBe(0);
  expect(staggerOffset(3, 0, 3000)).toBe(0);
  expect(staggerOffset(2, 7, 0)).toBe(0);
});

test("wraps the slot index so extra pollers stay in range", () => {
  expect(staggerOffset(7, 7, 3000)).toBe(0);
  expect(staggerOffset(8, 7, 3000)).toBe(staggerOffset(1, 7, 3000));
});

test("startStaggeredPoller delays the first run and then repeats", async () => {
  const runs: number[] = [];
  const started = Date.now();
  const stop = startStaggeredPoller(() => runs.push(Date.now() - started), 40, 60);
  await new Promise((r) => setTimeout(r, 170));
  stop();
  const countAfterStop = runs.length;
  await new Promise((r) => setTimeout(r, 100));
  expect(runs.length).toBe(countAfterStop); // stop() halts further runs
  expect(runs.length).toBeGreaterThanOrEqual(2); // first run + at least one repeat
  expect(runs[0]).toBeGreaterThanOrEqual(50); // first run waited ~60ms, not immediate
});
