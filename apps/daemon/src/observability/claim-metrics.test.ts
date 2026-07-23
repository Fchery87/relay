import { beforeEach, describe, expect, test } from "bun:test";
import { getClaimMetrics, resetClaimMetrics, timedClaim } from "./claim-metrics";

beforeEach(() => {
  resetClaimMetrics();
});

describe("timedClaim / getClaimMetrics", () => {
  test("records duration and classifies claimed vs empty outcomes", async () => {
    await timedClaim("conversations.claimQueuedMessage", async () => ({ threadId: "t1" }), (r) => (r ? "claimed" : "empty"));
    await timedClaim("conversations.claimQueuedMessage", async () => null, (r) => (r ? "claimed" : "empty"));

    const [snapshot] = getClaimMetrics();
    expect(snapshot!.kind).toBe("conversations.claimQueuedMessage");
    expect(snapshot!.count).toBe(2);
    expect(snapshot!.claimed).toBe(1);
    expect(snapshot!.empty).toBe(1);
    expect(snapshot!.errors).toBe(0);
    expect(snapshot!.p50Ms).toBeGreaterThanOrEqual(0);
  });

  test("records errors with cause and rethrows", async () => {
    await expect(
      timedClaim("subagents.claim", async () => {
        throw new TypeError("boom");
      }, () => "claimed"),
    ).rejects.toThrow("boom");

    const [snapshot] = getClaimMetrics();
    expect(snapshot!.errors).toBe(1);
    expect(snapshot!.errorKinds["TypeError"]).toBe(1);
  });

  test("tracks percentiles across many samples", async () => {
    for (let i = 0; i < 100; i++) {
      await timedClaim("conversations.claimQueuedMessage", async () => null, () => "empty");
    }
    const [snapshot] = getClaimMetrics();
    expect(snapshot!.count).toBe(100);
    expect(snapshot!.p95Ms).toBeGreaterThanOrEqual(snapshot!.p50Ms);
    expect(snapshot!.p99Ms).toBeGreaterThanOrEqual(snapshot!.p95Ms);
  });

  test("tracks separate kinds independently", async () => {
    await timedClaim("conversations.claimQueuedMessage", async () => null, () => "empty");
    await timedClaim("subagents.claim", async () => null, () => "empty");

    const snapshots = getClaimMetrics();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.kind).sort()).toEqual(["conversations.claimQueuedMessage", "subagents.claim"]);
  });
});
