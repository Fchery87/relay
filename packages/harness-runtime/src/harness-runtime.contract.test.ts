import { expect, test, describe } from "bun:test";
import type { HarnessRuntime } from "./harness-runtime";
import { FakeHarnessRuntime } from "./fake-harness-runtime";

// ---------------------------------------------------------------------------
// Conformance suite — runs against any HarnessRuntime implementation.
// Every test is a contract the runtime must satisfy.
// ---------------------------------------------------------------------------

function makeRuntime(): HarnessRuntime {
  return new FakeHarnessRuntime();
}

describe("HarnessRuntime conformance (fake)", () => {
  test("creates a run and returns a created snapshot", async () => {
    const rt = makeRuntime();
    const snap = await rt.createRun({ projectId: "test-project" });
    expect(snap.runId).toBeString();
    expect(snap.status).toBe("ready");
    expect(snap.sequence).toBeGreaterThan(0);
    expect(snap.streamVersion).toBeGreaterThan(0);
  });

  test("sends a turn and receives a turn receipt", async () => {
    const rt = makeRuntime();
    const snap = await rt.createRun({ projectId: "test" });
    await rt.resumeRun({ runId: snap.runId });
    const receipt = await rt.sendTurn({ runId: snap.runId, prompt: "hello" });
    expect(receipt.turnId).toBeString();
    expect(receipt.commandId).toBeString();
  });

  test("observes events in sequence after a turn", async () => {
    const rt = makeRuntime();
    const snap = await rt.createRun({ projectId: "test" });
    await rt.resumeRun({ runId: snap.runId });
    await rt.sendTurn({ runId: snap.runId, prompt: "hello" });

    const events: Array<{ type: string; sequence: number }> = [];
    for await (const ev of rt.observe({ runId: snap.runId })) {
      events.push({ type: ev.type, sequence: ev.sequence });
    }

    expect(events.length).toBeGreaterThanOrEqual(4);
    // Sequences are strictly increasing and start at 1
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.sequence).toBeGreaterThan(events[i - 1]!.sequence);
    }
  });

  test("observes after a given sequence", async () => {
    const rt = makeRuntime();
    const snap = await rt.createRun({ projectId: "test" });
    await rt.resumeRun({ runId: snap.runId });
    await rt.sendTurn({ runId: snap.runId, prompt: "hello" });

    // Observe all events first to find a mid-point
    const all: Array<{ sequence: number }> = [];
    for await (const ev of rt.observe({ runId: snap.runId })) {
      all.push({ sequence: ev.sequence });
    }
    const mid = all[Math.floor(all.length / 2)]!;
    const after: Array<{ sequence: number }> = [];
    for await (const ev of rt.observe({ runId: snap.runId, afterSequence: mid.sequence })) {
      after.push({ sequence: ev.sequence });
    }
    // All events after mid.sequence should have higher sequence
    for (const e of after) {
      expect(e.sequence).toBeGreaterThan(mid.sequence);
    }
  });

  test("steering injects a turn.steered event", async () => {
    const rt = makeRuntime();
    const snap = await rt.createRun({ projectId: "test" });
    await rt.resumeRun({ runId: snap.runId });
    await rt.sendTurn({ runId: snap.runId, prompt: "hello" });
    await rt.steerTurn({ runId: snap.runId, steering: "change direction" });

    let found = false;
    for await (const ev of rt.observe({ runId: snap.runId })) {
      if (ev.type === "turn.steered") found = true;
    }
    expect(found).toBe(true);
  });

  test("interrupting a turn emits turn.interrupted", async () => {
    const rt = makeRuntime();
    const snap = await rt.createRun({ projectId: "test" });
    await rt.resumeRun({ runId: snap.runId });
    await rt.interruptTurn({ runId: snap.runId, reason: "user cancel" });

    let found = false;
    for await (const ev of rt.observe({ runId: snap.runId })) {
      if (ev.type === "turn.interrupted") found = true;
    }
    expect(found).toBe(true);
  });

  test("resolving an approval emits approval.resolved", async () => {
    const rt = makeRuntime();
    const snap = await rt.createRun({ projectId: "test" });
    await rt.resumeRun({ runId: snap.runId });
    await rt.resolveApproval({ runId: snap.runId, approvalId: "appr-1", resolution: "allow" });

    let found = false;
    for await (const ev of rt.observe({ runId: snap.runId })) {
      if (ev.type === "approval.resolved") found = true;
    }
    expect(found).toBe(true);
  });

  test("stopping a run transitions to stopped", async () => {
    const rt = makeRuntime();
    const snap = await rt.createRun({ projectId: "test" });
    await rt.resumeRun({ runId: snap.runId });
    await rt.stopRun({ runId: snap.runId, reason: "test" });

    const final = await rt.snapshot({ runId: snap.runId });
    expect(final.status).toBe("stopped");
  });

  test("snapshot returns the current state", async () => {
    const rt = makeRuntime();
    const snap = await rt.createRun({ projectId: "test" });
    const current = await rt.snapshot({ runId: snap.runId });
    expect(current.runId).toBe(snap.runId);
    expect(current.status).toBe(snap.status);
  });

  test("provider failure produces a thrown error", async () => {
    const failing = new FakeHarnessRuntime({ scriptedEvents: [], providerFails: true });
    const snap = await failing.createRun({ projectId: "test" });
    await failing.resumeRun({ runId: snap.runId });
    await expect(failing.sendTurn({ runId: snap.runId, prompt: "boom" })).rejects.toThrow(
      "Provider process lost",
    );
  });

  test("creating two runs produces independent snapshots", async () => {
    const rt = makeRuntime();
    const a = await rt.createRun({ projectId: "a" });
    const b = await rt.createRun({ projectId: "b" });
    expect(a.runId).not.toBe(b.runId);
    // Both are ready
    const sa = await rt.snapshot({ runId: a.runId });
    const sb = await rt.snapshot({ runId: b.runId });
    expect(sa.status).toBe("ready");
    expect(sb.status).toBe("ready");
  });
});
