import { describe, expect, test } from "bun:test";

import { machinePresence } from "./machines";

describe("machinePresence", () => {
  test("reports a recently heartbeating machine as online", () => {
    expect(
      machinePresence({
        heartbeatAt: 1_000,
        now: 1_999,
        offlineAfterMs: 1_000,
      }),
    ).toBe("online");
  });

  test("reports an expired heartbeat as offline", () => {
    expect(
      machinePresence({
        heartbeatAt: 1_000,
        now: 2_000,
        offlineAfterMs: 1_000,
      }),
    ).toBe("offline");
  });
});
