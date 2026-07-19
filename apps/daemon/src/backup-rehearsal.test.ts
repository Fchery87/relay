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

      // Send a turn, then simulate explicit provider output.
      const firstTurn = await runtime.sendTurn({
        runId: snap.runId,
        prompt: "build a feature",
      });
      await completeTurn(runtime, runId, "before-restart");

      // Append additional events
      await runtime.appendEvent(runId, {
        eventId: "ev-ckpt-1",
        type: "checkpoint.captured",
        turnId: firstTurn.turnId,
        payload: {
          checkpointId: "ckpt-1" as never,
          commit: "abc123def",
          ref: "refs/relay/ckpt-1",
        },
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
      const eventsBefore = await collectEventIdentities(runtime, runId);

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
      const replayedEvents = await collectEventIdentities(restored, runId);

      expect(replayedEvents.length).toBe(eventsBefore.length);
      for (let i = 0; i < replayedEvents.length; i++) {
        expect(replayedEvents[i]!.eventId).toBe(eventsBefore[i]!.eventId);
        expect(replayedEvents[i]!.type).toBe(eventsBefore[i]!.type);
      }

      // Phase 3: Continue operating on the restored runtime
      await restored.sendTurn({ runId: snap.runId, prompt: "continue after restore" });
      await completeTurn(restored, runId, "after-restore");
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
    const events = await collectEvents(runtime, runId);
    expect(events.some((e) => e.type === "run.created")).toBe(true);
    expect(events.some((e) => e.type === "run.started")).toBe(true);

    runtime.close();
  });
});

async function collectEvents(runtime: LocalHarnessRuntime, runId: string) {
  const snapshot = runtime.getSnapshotByRunId(runId);
  if (!snapshot) throw new Error(`Run not found: ${runId}`);
  const events: Array<{
    eventId: string;
    type: string;
    payload: unknown;
    sequence: number;
  }> = [];
  for await (const ev of runtime.observe({ runId: runId as never, afterSequence: -1 })) {
    events.push({
      eventId: ev.eventId,
      type: ev.type,
      payload: ev.payload,
      sequence: ev.sequence,
    });
    if (ev.sequence >= snapshot.sequence) break;
  }
  return events;
}

async function collectEventIdentities(
  runtime: LocalHarnessRuntime,
  runId: string,
): Promise<Array<{ eventId: string; type: string }>> {
  return (await collectEvents(runtime, runId)).map((event) => ({
    eventId: event.eventId,
    type: event.type,
  }));
}

async function completeTurn(
  runtime: LocalHarnessRuntime,
  runId: string,
  suffix: string,
): Promise<void> {
  const turnId = runtime.getSnapshotByRunId(runId)?.activeTurnId;
  if (!turnId) throw new Error(`Run has no active turn: ${runId}`);
  await runtime.appendEvent(runId, {
    eventId: `ev-assistant-delta-${suffix}`,
    type: "assistant.delta",
    turnId,
    payload: { text: "done" },
  });
  await runtime.appendEvent(runId, {
    eventId: `ev-assistant-completed-${suffix}`,
    type: "assistant.completed",
    turnId,
    payload: {},
  });
  await runtime.appendEvent(runId, {
    eventId: `ev-turn-completed-${suffix}`,
    type: "turn.completed",
    turnId,
    payload: { summary: "done" },
  });
}
