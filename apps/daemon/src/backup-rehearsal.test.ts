// ---------------------------------------------------------------------------
// Backup/rollback rehearsal — verifies snapshot serialization, crash
// simulation, deterministic replay, and continuation after restore.
// ---------------------------------------------------------------------------

import { expect, test, describe } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { LocalHarnessRuntime } from "@relay/harness-runtime";

describe("Backup/rollback rehearsal", () => {
  test("serialize snapshot, simulate crash, restore, continue", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "relay-rehearsal-"));
    try {
      // Phase 1: Create run, send turns, collect events
      const dbPath = join(tmp, "relay.sqlite");
      const runtime = LocalHarnessRuntime.open(dbPath, { maxConcurrentRuns: 4 });
      const snap = await runtime.createRun({ projectId: "proj-rehearsal" });
      const runId = snap.runId as string;
      await runtime.resumeRun({ runId: snap.runId });

      // Send a turn — this produces turn.started + assistant.delta + turn.completed
      await runtime.sendTurn({ runId: snap.runId, prompt: "build a feature" });

      // Append additional events
      await runtime.appendEvent(runId, {
        eventId: "ev-ckpt-1",
        type: "checkpoint.captured",
        payload: { commit: "abc123def", projectPath: "/tmp/test", threadId: "thr-1" },
      });
      await runtime.appendEvent(runId, {
        eventId: "ev-usage-1",
        type: "usage.recorded",
        payload: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 50, modelId: "test" },
      });

      // Snapshot the current state
      const snapshot = runtime.getSnapshotByRunId(runId as never);
      expect(snapshot).toBeTruthy();
      const snapshotJson = JSON.stringify(snapshot);
      const eventsBefore: Array<{ eventId: string; type: string }> = [];
      for await (const ev of runtime.observe({ runId: runId as never, afterSequence: -1 })) {
        eventsBefore.push({ eventId: ev.eventId, type: ev.type });
      }

      // Serialize to disk
      const snapshotPath = join(tmp, "snapshot.json");
      writeFileSync(snapshotPath, snapshotJson);
      expect(JSON.parse(readFileSync(snapshotPath, "utf-8")).runId).toBe(runId);

      // Serialize event log
      const eventsPath = join(tmp, "events.json");
      writeFileSync(eventsPath, JSON.stringify(eventsBefore));

      runtime.close();

      // Phase 2: Simulate crash — open a fresh runtime
      const restored = LocalHarnessRuntime.open(dbPath, { maxConcurrentRuns: 4 });

      // Verify snapshot is recoverable
      const restoredSnapshot = restored.getSnapshotByRunId(runId as never);
      expect(restoredSnapshot).toBeTruthy();
      expect(restoredSnapshot!.runId).toBe(runId as never);
      expect(restoredSnapshot!.sequence).toBe(snapshot!.sequence);

      // Verify all events are replayed identically
      const replayedEvents: Array<{ eventId: string; type: string }> = [];
      for await (const ev of restored.observe({ runId: runId as never, afterSequence: -1 })) {
        replayedEvents.push({ eventId: ev.eventId, type: ev.type });
      }

      expect(replayedEvents.length).toBe(eventsBefore.length);
      for (let i = 0; i < replayedEvents.length; i++) {
        expect(replayedEvents[i]!.eventId).toBe(eventsBefore[i]!.eventId);
        expect(replayedEvents[i]!.type).toBe(eventsBefore[i]!.type);
      }

      // Phase 3: Continue operating on the restored runtime
      await restored.sendTurn({ runId: snap.runId, prompt: "continue after restore" });
      const eventsAfter = await collectEvents(restored, runId);
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
      expect(eventsAfter.some((e) => e.type === "turn.completed")).toBe(true);

      restored.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("restore from empty runtime returns undefined gracefully", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const result = runtime.getSnapshotByRunId("nonexistent" as never);
    expect(result).toBeUndefined();
    runtime.close();
  });

  test("snapshot round-trip preserves all required fields", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const snap = await runtime.createRun({ projectId: "proj-fields" });
    const runId = snap.runId as string;

    await runtime.appendEvent(runId, {
      eventId: "ev-field-test",
      type: "run.started",
      payload: {},
    });

    const snapshot = runtime.getSnapshotByRunId(runId);
    expect(snapshot).toBeTruthy();
    expect(snapshot!.runId).toBe(runId as never);
    expect(snapshot!.status).toBeTruthy();
    expect(snapshot!.sequence).toBeGreaterThanOrEqual(0);

    // Snapshot should be serializable
    const json = JSON.stringify(snapshot);
    const reparsed = JSON.parse(json) as Record<string, unknown>;
    expect(reparsed.runId).toBe(runId);
    expect((reparsed as { sequence: number }).sequence).toBeGreaterThanOrEqual(0);

    // Verify events are replayable from this snapshot
    const events: Array<{ type: string }> = [];
    for await (const ev of runtime.observe({ runId: runId as never, afterSequence: -1 })) {
      events.push({ type: ev.type });
    }
    expect(events.some((e) => e.type === "run.created")).toBe(true);
    expect(events.some((e) => e.type === "run.started")).toBe(true);

    runtime.close();
  });
});

async function collectEvents(runtime: LocalHarnessRuntime, runId: string) {
  const events: Array<{ type: string; payload: unknown }> = [];
  for await (const ev of runtime.observe({ runId: runId as never, afterSequence: -1 })) {
    events.push(ev);
  }
  return events;
}
