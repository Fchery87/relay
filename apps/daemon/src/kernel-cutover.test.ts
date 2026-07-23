import { expect, test } from "bun:test";

import { effectiveRuntimeMode, gatesFromEvidence } from "./kernel-cutover";

const readyGates = {
  acceptanceGatesPassed: true,
  backupRehearsalVerified: true,
  kernelReady: true,
  releaseWindowSatisfied: true,
  zeroLegacyActivations: true,
};

test("explicit runtime mode remains authoritative during staged rollout", () => {
  expect(effectiveRuntimeMode("legacy", readyGates)).toBe("legacy");
  expect(effectiveRuntimeMode("shadow", readyGates)).toBe("shadow");
  expect(effectiveRuntimeMode("kernel", { ...readyGates, releaseWindowSatisfied: false })).toBe("kernel");
});

test("implicit mode stays legacy until every cutover gate passes", () => {
  expect(effectiveRuntimeMode(undefined, { ...readyGates, zeroLegacyActivations: false })).toBe("legacy");
  expect(effectiveRuntimeMode(undefined, readyGates)).toBe("kernel");
});

test("release evidence requires a kernel start before the release window can count", () => {
  expect(gatesFromEvidence({ legacyActivations: 0, backupHash: "backup", acceptanceHash: "accept", releaseWindowEndedAt: 20 })).toMatchObject({
    kernelReady: false,
    releaseWindowSatisfied: false,
  });
  expect(gatesFromEvidence({ kernelReadyAt: 10, legacyActivations: 0, backupHash: "backup", acceptanceHash: "accept", releaseWindowEndedAt: 20 })).toEqual(readyGates);
});
