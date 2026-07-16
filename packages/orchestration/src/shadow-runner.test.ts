import { expect, test, describe } from "bun:test";
import {
  ShadowRunner,
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
});
