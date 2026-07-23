import { expect, test } from "bun:test";

import {
  protectedCrossTierTestEnabled,
  protectedCrossTierPrerequisitesMet,
} from "../../../scripts/lib/protected-test-gate";

test("protected cross-tier tests require an explicit opt-in", () => {
  expect(protectedCrossTierTestEnabled({})).toBe(false);
  expect(protectedCrossTierTestEnabled({ RELAY_CROSS_TIER: "0" })).toBe(false);
  expect(protectedCrossTierTestEnabled({ RELAY_CROSS_TIER: "1" })).toBe(true);
});

test("explicit cross-tier opt-in fails when protected prerequisites are missing", () => {
  expect(() => protectedCrossTierPrerequisitesMet({
    enabled: false,
    backendAvailable: false,
    loopbackAvailable: false,
  })).not.toThrow();
  expect(() => protectedCrossTierPrerequisitesMet({
    enabled: true,
    backendAvailable: true,
    loopbackAvailable: true,
  })).not.toThrow();
  expect(() => protectedCrossTierPrerequisitesMet({
    enabled: true,
    backendAvailable: false,
    loopbackAvailable: true,
  })).toThrow("RELAY_CROSS_TIER=1 requires");
});
