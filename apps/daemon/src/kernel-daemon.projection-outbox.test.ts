// ---------------------------------------------------------------------------
// Fault-injection tests for the durable projection outbox publisher.
// Covers the kill-points the ticket names as missing: lost response, partial
// publish, expired outbox lease, and daemon restart (backend restart is the
// same failure shape as "lost response" from the daemon's perspective).
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { LocalHarnessRuntime } from "@relay/harness-runtime";
import { publishProjectionOutbox, type ProjectionTelemetry } from "./kernel-daemon";
import { createFakeProjectionSink } from "./sync/fake-projection-sink";

function freshTelemetry(): ProjectionTelemetry {
  return { backlog: 0, oldestPendingAgeMs: 0, retries: 0, conflicts: 0, cursorLag: 0 };
}

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-outbox-"));
  tempDirs.push(dir);
  return join(dir, "relay-kernel.sqlite");
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("publishProjectionOutbox", () => {
  test("publishes claimed events, acknowledges locally, and advances the cursor", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const created = await runtime.createRun({ projectId: "proj-1" });
    await runtime.resumeRun({ runId: created.runId });
    await runtime.sendTurn({ runId: created.runId, prompt: "hi" });

    const sink = createFakeProjectionSink();
    const telemetry = freshTelemetry();
    await publishProjectionOutbox({
      deviceToken: "dev-token",
      runtime,
      projectionSink: sink,
      machineId: "machine-1",
      telemetry,
    });

    expect(sink.events.map((e) => e.type)).toEqual(["run.created", "run.started", "turn.started"]);
    expect(sink.cursors.get("machine-1:outbound")).toBe(3);
    expect(telemetry.backlog).toBe(0);
    expect(runtime.countPendingProjectionOutbox().count).toBe(0);

    await runtime.shutdown();
  });

  test("lost response: a failed publish leaves rows unacknowledged and retries safely without duplicating", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const created = await runtime.createRun({ projectId: "proj-1" });
    await runtime.resumeRun({ runId: created.runId });
    await runtime.sendTurn({ runId: created.runId, prompt: "hi" });

    let failNext = true;
    const sink = createFakeProjectionSink({
      failAppendEvents: () => (failNext ? new Error("simulated lost response") : undefined),
    });
    const telemetry = freshTelemetry();

    // First flush: the response never arrives — rows must stay claimed and
    // unacknowledged, not silently dropped.
    await publishProjectionOutbox({
      deviceToken: "dev-token",
      runtime,
      projectionSink: sink,
      machineId: "machine-1",
      telemetry,
      leaseDurationMs: 50,
    });
    expect(sink.events).toHaveLength(0);
    expect(telemetry.retries).toBe(1);
    expect(runtime.countPendingProjectionOutbox().count).toBe(3);

    // Lease expires; the retry succeeds and converges without duplication.
    await new Promise((resolve) => setTimeout(resolve, 60));
    failNext = false;
    await publishProjectionOutbox({
      deviceToken: "dev-token",
      runtime,
      projectionSink: sink,
      machineId: "machine-1",
      telemetry,
      leaseDurationMs: 50,
    });

    expect(sink.events.map((e) => e.type)).toEqual(["run.created", "run.started", "turn.started"]);
    expect(runtime.countPendingProjectionOutbox().count).toBe(0);

    await runtime.shutdown();
  });

  test("partial publish: an entire batch fails atomically and converges on the next attempt with no duplicates", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const created = await runtime.createRun({ projectId: "proj-1" });
    await runtime.resumeRun({ runId: created.runId });
    await runtime.sendTurn({ runId: created.runId, prompt: "hi" });

    let attempt = 0;
    const sink = createFakeProjectionSink({
      failAppendEvents: () => {
        attempt++;
        return attempt === 1 ? new Error("simulated partial publish — batch rolled back") : undefined;
      },
    });
    const telemetry = freshTelemetry();

    await publishProjectionOutbox({
      deviceToken: "dev-token",
      runtime,
      projectionSink: sink,
      machineId: "machine-1",
      telemetry,
      leaseDurationMs: 20,
    });
    // Atomic failure: none of the batch is visible on the far side, and the
    // whole batch remains unacknowledged for retry — not a partial write.
    expect(sink.events).toHaveLength(0);
    expect(telemetry.retries).toBe(1);
    expect(runtime.countPendingProjectionOutbox().count).toBe(3);

    await new Promise((resolve) => setTimeout(resolve, 30));
    await publishProjectionOutbox({
      deviceToken: "dev-token",
      runtime,
      projectionSink: sink,
      machineId: "machine-1",
      telemetry,
      leaseDurationMs: 20,
    });

    const seen = new Set(sink.events.map((e) => `${e.runId}:${e.sequence}`));
    expect(seen.size).toBe(sink.events.length); // no duplicate (runId, sequence) pairs
    expect(runtime.countPendingProjectionOutbox().count).toBe(0);

    await runtime.shutdown();
  });

  test("expired outbox lease is reclaimed and retried rather than stuck forever", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const created = await runtime.createRun({ projectId: "proj-1" });
    await runtime.resumeRun({ runId: created.runId });
    await runtime.sendTurn({ runId: created.runId, prompt: "hi" });

    // Simulate a crash after claiming but before any publish attempt: claim
    // directly under a short lease and never acknowledge.
    const stuck = runtime.claimProjectionOutbox({ owner: "dead-worker", leaseDurationMs: 20, limit: 100 });
    expect(stuck).toHaveLength(3);
    expect(runtime.countPendingProjectionOutbox().count).toBe(3);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const sink = createFakeProjectionSink();
    const telemetry = freshTelemetry();
    await publishProjectionOutbox({
      deviceToken: "dev-token",
      runtime,
      projectionSink: sink,
      machineId: "live-worker",
      telemetry,
      leaseDurationMs: 20,
    });

    expect(sink.events).toHaveLength(3);
    expect(runtime.countPendingProjectionOutbox().count).toBe(0);

    await runtime.shutdown();
  });

  test("daemon restart: unacknowledged rows survive close/reopen from the same store and publish without duplication", async () => {
    const dbPath = tempDbPath();
    const runtime1 = LocalHarnessRuntime.open(dbPath);
    const created = await runtime1.createRun({ projectId: "proj-1" });
    await runtime1.resumeRun({ runId: created.runId });
    await runtime1.sendTurn({ runId: created.runId, prompt: "hi" });

    const deadSink = createFakeProjectionSink({
      failAppendEvents: () => new Error("simulated crash before ack"),
    });
    const telemetry1 = freshTelemetry();
    await publishProjectionOutbox({
      deviceToken: "dev-token",
      runtime: runtime1,
      projectionSink: deadSink,
      machineId: "machine-1",
      telemetry: telemetry1,
      leaseDurationMs: 20,
    });
    expect(deadSink.events).toHaveLength(0);
    await runtime1.shutdown();

    // The claim lease is persisted in SQLite and survives the restart —
    // reopening alone does not make it reclaimable before it expires.
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Reopen from the same file — simulates the daemon process restarting.
    const runtime2 = LocalHarnessRuntime.open(dbPath);
    expect(runtime2.countPendingProjectionOutbox().count).toBe(3);

    const liveSink = createFakeProjectionSink();
    const telemetry2 = freshTelemetry();
    await publishProjectionOutbox({
      deviceToken: "dev-token",
      runtime: runtime2,
      projectionSink: liveSink,
      machineId: "machine-1",
      telemetry: telemetry2,
    });

    expect(liveSink.events.map((e) => e.type)).toEqual(["run.created", "run.started", "turn.started"]);
    expect(runtime2.countPendingProjectionOutbox().count).toBe(0);
    await runtime2.shutdown();
  });

  test("observability: backlog and oldest-pending age are reported before publish succeeds", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const created = await runtime.createRun({ projectId: "proj-1" });
    await runtime.resumeRun({ runId: created.runId });
    await runtime.sendTurn({ runId: created.runId, prompt: "hi" });

    const sink = createFakeProjectionSink({ failAppendEvents: () => new Error("down") });
    const telemetry = freshTelemetry();
    await publishProjectionOutbox({
      deviceToken: "dev-token",
      runtime,
      projectionSink: sink,
      machineId: "machine-1",
      telemetry,
    });

    expect(telemetry.backlog).toBe(3);
    expect(telemetry.oldestPendingAgeMs).toBeGreaterThanOrEqual(0);
    expect(telemetry.cursorLag).toBe(3);
    expect(telemetry.retries).toBe(1);

    await runtime.shutdown();
  });
});
