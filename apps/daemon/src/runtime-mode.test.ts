import { expect, test } from "bun:test";

import { canaryRollbackReason, resolveMaxConcurrentRuns, resolveRuntimeMode, shouldRollback, type CanaryTelemetry } from "./runtime-mode";

const healthyTelemetry: CanaryTelemetry = {
  activeLeases: 1,
  authFailures: 0,
  duplicateCommands: 0,
  fallbackActivations: 0,
  mode: "kernel",
  pendingEffects: 0,
  projectionBacklog: 0,
  projectionDivergences: 0,
  projectionGaps: 0,
  recoverableFailures: 0,
  sandboxViolations: 0,
  unrecoverableFailures: 0,
};

test("defaults to legacy when RELAY_RUNTIME_MODE is not set (migration safety)", () => {
  expect(resolveRuntimeMode({})).toBe("legacy");
});

test("parses legacy", () => {
  expect(resolveRuntimeMode({ RELAY_RUNTIME_MODE: "legacy" })).toBe("legacy");
});

test("parses shadow", () => {
  expect(resolveRuntimeMode({ RELAY_RUNTIME_MODE: "shadow" })).toBe("shadow");
});

test("parses kernel", () => {
  expect(resolveRuntimeMode({ RELAY_RUNTIME_MODE: "kernel" })).toBe("kernel");
});

test("rejects unknown values", () => {
  expect(() => resolveRuntimeMode({ RELAY_RUNTIME_MODE: "invalid" })).toThrow(
    /RELAY_RUNTIME_MODE/,
  );
});

test("rejects empty string", () => {
  expect(() => resolveRuntimeMode({ RELAY_RUNTIME_MODE: "" })).toThrow(
    /RELAY_RUNTIME_MODE/,
  );
});

test("kernel disabled kill-switch blocks shadow mode", () => {
  expect(() =>
    resolveRuntimeMode({ RELAY_RUNTIME_MODE: "shadow", RELAY_KERNEL_DISABLED: "1" }),
  ).toThrow(/RELAY_KERNEL_DISABLED/);
});

test("kernel disabled kill-switch blocks kernel mode", () => {
  expect(() =>
    resolveRuntimeMode({ RELAY_RUNTIME_MODE: "kernel", RELAY_KERNEL_DISABLED: "1" }),
  ).toThrow(/RELAY_KERNEL_DISABLED/);
});

test("kernel disabled kill-switch allows legacy", () => {
  expect(
    resolveRuntimeMode({ RELAY_RUNTIME_MODE: "legacy", RELAY_KERNEL_DISABLED: "1" }),
  ).toBe("legacy");
});

test("kernel disabled not set allows kernel mode", () => {
  expect(
    resolveRuntimeMode({ RELAY_RUNTIME_MODE: "kernel", RELAY_KERNEL_DISABLED: "0" }),
  ).toBe("kernel");
});

test("kernel disabled allows kernel when absent", () => {
  expect(resolveRuntimeMode({ RELAY_RUNTIME_MODE: "kernel" })).toBe("kernel");
});

test("canary rollback defaults to fail closed on invariant violations", () => {
  expect(shouldRollback({ ...healthyTelemetry, projectionGaps: 1 })).toBe(true);
  expect(canaryRollbackReason({ ...healthyTelemetry, projectionDivergences: 1 })).toBe("projection-divergence");
  expect(canaryRollbackReason(healthyTelemetry)).toBeUndefined();
});

test("canary rollback thresholds can tolerate bounded recoverable signals", () => {
  expect(shouldRollback({ ...healthyTelemetry, projectionGaps: 1 }, {
    maxProjectionDivergences: 0,
    maxProjectionGaps: 1,
    maxSandboxViolations: 0,
    maxUnrecoverableFailures: 0,
  })).toBe(false);
});

// RELAY_KERNEL_MAX_CONCURRENT_RUNS

test("defaults max concurrent runs when not set", () => {
  expect(resolveMaxConcurrentRuns({})).toBe(4);
});

test("parses a positive integer", () => {
  expect(resolveMaxConcurrentRuns({ RELAY_KERNEL_MAX_CONCURRENT_RUNS: "8" })).toBe(8);
});

test("rejects zero", () => {
  expect(() => resolveMaxConcurrentRuns({ RELAY_KERNEL_MAX_CONCURRENT_RUNS: "0" })).toThrow(
    /RELAY_KERNEL_MAX_CONCURRENT_RUNS/,
  );
});

test("rejects negative", () => {
  expect(() => resolveMaxConcurrentRuns({ RELAY_KERNEL_MAX_CONCURRENT_RUNS: "-1" })).toThrow(
    /RELAY_KERNEL_MAX_CONCURRENT_RUNS/,
  );
});

test("rejects non-numeric", () => {
  expect(() => resolveMaxConcurrentRuns({ RELAY_KERNEL_MAX_CONCURRENT_RUNS: "abc" })).toThrow(
    /RELAY_KERNEL_MAX_CONCURRENT_RUNS/,
  );
});

test("rejects float", () => {
  expect(() => resolveMaxConcurrentRuns({ RELAY_KERNEL_MAX_CONCURRENT_RUNS: "2.5" })).toThrow(
    /RELAY_KERNEL_MAX_CONCURRENT_RUNS/,
  );
});
