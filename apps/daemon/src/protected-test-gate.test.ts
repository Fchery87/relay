import { expect, test } from "bun:test";

import { protectedCrossTierTestEnabled } from "../../../scripts/lib/protected-test-gate";

test("protected cross-tier tests require an explicit opt-in", () => {
  expect(protectedCrossTierTestEnabled({})).toBe(false);
  expect(protectedCrossTierTestEnabled({ RELAY_CROSS_TIER: "0" })).toBe(false);
  expect(protectedCrossTierTestEnabled({ RELAY_CROSS_TIER: "1" })).toBe(true);
});
