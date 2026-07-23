import { expect, test } from "bun:test";

import { createReleaseEvidence } from "./release-evidence";
import { toConvexReleaseEvidenceArgs } from "./record-release-evidence";

const completeEvidence = () => createReleaseEvidence({
  commit: "abc123",
  gates: {
    backupRehearsal: true,
    canaryRollout: true,
    kernelReady: true,
    productionAcceptance: true,
    providerConformance: true,
    releaseWindow: true,
    shadowParity: true,
    supportedOsConformance: true,
    zeroLegacyActivations: true,
  },
  migrationState: "widened-compatible",
  rehearsalHash: "sha256:backup-rehearsal",
  residualRisks: [],
  sourceArtifacts: ["release.json"],
  testIds: ["cross-tier-recovery"],
  topology: { backend: "self-hosted", deployment: "canary", platform: "linux" },
  versions: { backend: "pinned", bun: "1.3.14", daemon: "1.0.0" },
});

test("maps complete release evidence to the internal Convex gate record", () => {
  expect(toConvexReleaseEvidenceArgs(completeEvidence())).toEqual({
    backupRehearsal: true,
    canaryRollout: true,
    kernelReady: true,
    productionAcceptance: true,
    providerConformance: true,
    releaseWindow: true,
    rehearsalHash: "sha256:backup-rehearsal",
    shadowParity: true,
    supportedOsConformance: true,
    zeroLegacyActivations: true,
  });
});

test("does not record blocked release evidence", () => {
  const evidence = createReleaseEvidence({
    ...completeEvidence(),
    gates: { ...completeEvidence().gates, releaseWindow: false },
  });

  expect(() => toConvexReleaseEvidenceArgs(evidence)).toThrow(/promotion is blocked/i);
});
