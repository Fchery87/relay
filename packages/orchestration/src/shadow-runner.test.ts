import { expect, test, describe } from "bun:test";
import {
  ShadowRunner,
  ShadowEffectFence,
  defaultSnapshotComparator,
  defaultEventComparator,
} from "./shadow-runner";
import type { RunSnapshot, EventEnvelope } from "@relay/contracts";

function snap(status: string, sequence = 0): RunSnapshot {
  return {
    runId: "run-1" as never,
    status: status as never,
    sequence,
    streamVersion: sequence,
    restartCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("ShadowRunner", () => {
  test("reports parity when kernel and legacy match", () => {
    const runner = new ShadowRunner({
      compareSnapshots: defaultSnapshotComparator,
      compareEvents: defaultEventComparator,
    });
    const report = runner.run(
      snap("running", 5),
      snap("running", 5),
      [],
      [],
    );
    expect(report.ok).toBe(true);
    expect(report.divergences).toHaveLength(0);
  });

  test("reports divergence when statuses differ", () => {
    const runner = new ShadowRunner({
      compareSnapshots: defaultSnapshotComparator,
      compareEvents: defaultEventComparator,
    });
    const report = runner.run(
      snap("completed", 3),
      snap("running", 3),
      [],
      [],
    );
    expect(report.ok).toBe(false);
    expect(report.divergences.length).toBeGreaterThan(0);
  });

  test("reports divergence when kernel sequence is behind", () => {
    const runner = new ShadowRunner({
      compareSnapshots: defaultSnapshotComparator,
      compareEvents: defaultEventComparator,
    });
    const report = runner.run(
      snap("running", 2),
      snap("running", 5),
      [],
      [],
    );
    expect(report.ok).toBe(false);
    expect(report.divergences.some((d) => d.includes("Sequence"))).toBe(true);
  });

  test("compares activity, approval, usage, checkpoint, and terminal projections", () => {
    const event = (type: string, payload: Record<string, unknown>) => ({
      eventId: `${type}-1` as never,
      sequence: 1,
      streamVersion: 1,
      type: type as never,
      runId: "run-1" as never,
      turnId: "turn-1" as never,
      correlationId: "corr-1" as never,
      occurredAt: 1,
      payload,
    }) as EventEnvelope<never, unknown>;
    const divergences = defaultEventComparator(
      [event("activity.completed", { activityId: "a", summary: "done" }), event("usage.recorded", { inputTokens: 1, outputTokens: 2 })],
      [event("activity.failed", { activityId: "a", error: "failed" }), event("usage.recorded", { inputTokens: 1, outputTokens: 3 })],
    );
    expect(divergences.some((item) => item.includes("activity.completed"))).toBe(true);
    expect(divergences.some((item) => item.includes("usage.recorded"))).toBe(true);
  });

  test("requires an explicit allowlist for harmless text formatting", () => {
    const event = (text: string) => ({
      eventId: text as never,
      sequence: 1,
      streamVersion: 1,
      type: "assistant.delta" as never,
      runId: "run-1" as never,
      turnId: "turn-1" as never,
      correlationId: "corr-1" as never,
      occurredAt: 1,
      payload: { text },
    }) as EventEnvelope<never, unknown>;
    expect(defaultEventComparator([event("hello")], [event("hello ")])).toHaveLength(1);
    expect(defaultEventComparator([event("hello")], [event("hello ")], { allowFormatting: true })).toHaveLength(0);
  });

  test("keeps shadow effects legacy-owned and idempotent", () => {
    const fence = new ShadowEffectFence();
    fence.record({ effectId: "effect-1", kind: "provider.send_turn", owner: "legacy" });
    fence.record({ effectId: "effect-1", kind: "provider.send_turn", owner: "legacy" });
    expect(() => fence.record({ effectId: "effect-1", kind: "workspace.write", owner: "shadow" })).toThrow(/legacy-owned/);
    expect(fence.effects).toHaveLength(1);
  });
});
