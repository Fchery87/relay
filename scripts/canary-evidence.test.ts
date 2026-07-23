import { expect, test } from "bun:test";

import { createCanaryEvidence } from "./canary-evidence";

const telemetry = {
  activeLeases: 0,
  authFailures: 0,
  duplicateCommands: 0,
  fallbackActivations: 0,
  mode: "kernel" as const,
  pendingEffects: 0,
  projectionBacklog: 0,
  projectionDivergences: 0,
  projectionGaps: 0,
  recoverableFailures: 0,
  sandboxViolations: 0,
  unrecoverableFailures: 0,
};

test("canary evidence records bounded release facts without blocking a healthy stage", () => {
  const evidence = createCanaryEvidence({
    commit: "abc123",
    migrationState: "fresh-start",
    residualRisks: ["provider evidence pending"],
    runtimeMode: "kernel",
    stage: "developer",
    testIds: ["cross-tier-12-pass"],
    topology: { backend: "self-hosted", deployment: "isolated", platform: "linux" },
    versions: { backend: "1.0.0", bun: "1.3.14", daemon: "1.0.0" },
    telemetry,
  });

  expect(evidence).toMatchObject({ promotionBlocked: false, stage: "developer", testIds: ["cross-tier-12-pass"] });
});

test("canary evidence blocks promotion when telemetry contains an invariant violation and redacts failures", () => {
  const evidence = createCanaryEvidence({
    commit: "abc123",
    failures: ["provider failed with sk-test-secret"],
    migrationState: "fresh-start",
    residualRisks: [],
    runtimeMode: "kernel",
    stage: "internal",
    testIds: [],
    topology: { backend: "self-hosted", deployment: "isolated", platform: "linux" },
    versions: { backend: "1.0.0", bun: "1.3.14", daemon: "1.0.0" },
    telemetry: { ...telemetry, projectionDivergences: 1 },
  });

  expect(evidence.promotionBlocked).toBe(true);
  expect(evidence.redactedFailures[0]).not.toContain("sk-test-secret");
  expect(evidence.redactedFailures[0]).toContain("[REDACTED]");
});
