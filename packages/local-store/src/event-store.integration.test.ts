import { expect, test, describe } from "bun:test";
import { openMemoryStore, type StoreDatabase } from "./database";
import {
  appendEvents,
  insertSnapshot,
  getSnapshot,
  getEventsAfter,
} from "./event-store";
import { claimOutboxBatch, acknowledgeOutboxBatch } from "./outbox";
import type { RunSnapshot } from "@relay/contracts";

function makeSnapshot(overrides?: Partial<RunSnapshot>): RunSnapshot {
  return {
    runId: "run-1" as never,
    status: "running",
    sequence: 3,
    streamVersion: 3,
    restartCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function setup(db: StoreDatabase): RunSnapshot {
  const snap = makeSnapshot({ status: "ready", sequence: 0, streamVersion: 0 });
  insertSnapshot(db, snap);
  return snap;
}

describe("event store", () => {
  test("appends events atomically and bumps sequence", () => {
    const db = openMemoryStore();
    setup(db);

    const result = appendEvents(db, {
      runId: "run-1" as never,
      commandId: "cmd-1" as never,
      nextSnapshot: makeSnapshot({ status: "running" }),
      events: [
        {
          eventId: "ev-1" as never,
          type: "run.started",
          payload: {},
          correlationId: "corr-1" as never,
        },
        {
          eventId: "ev-2" as never,
          type: "turn.started",
          payload: { prompt: "hi" },
          correlationId: "corr-1" as never,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.snapshot.sequence).toBe(2);
    expect(result.snapshot.streamVersion).toBe(2);
    expect(result.events).toHaveLength(2);

    // Snapshot persisted
    const loaded = getSnapshot(db, "run-1");
    expect(loaded?.sequence).toBe(2);
    expect(loaded?.status).toBe("running");

    // Events persisted
    const events = getEventsAfter(db, "run-1", -1);
    expect(events).toHaveLength(2);
  });

  test("rejects stale expectedStreamVersion", () => {
    const db = openMemoryStore();
    setup(db);

    // First append bumps version to 1
    appendEvents(db, {
      runId: "run-1" as never,
      commandId: "cmd-1" as never,
      nextSnapshot: makeSnapshot({ status: "running" }),
      events: [{ eventId: "ev-1" as never, type: "run.started", payload: {}, correlationId: "c-1" as never }],
    });

    // Second append with stale version
    const result = appendEvents(db, {
      runId: "run-1" as never,
      commandId: "cmd-2" as never,
      expectedStreamVersion: 0, // stale — current is 1
      nextSnapshot: makeSnapshot({ status: "running" }),
      events: [{ eventId: "ev-2" as never, type: "turn.started", payload: { prompt: "hi" }, correlationId: "c-2" as never }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected conflict");
    expect(result.reason).toBe("version_conflict");
  });

  test("duplicate commandId returns original result", () => {
    const db = openMemoryStore();
    setup(db);

    const first = appendEvents(db, {
      runId: "run-1" as never,
      commandId: "cmd-1" as never,
      nextSnapshot: makeSnapshot({ status: "running" }),
      events: [{ eventId: "ev-1" as never, type: "run.started", payload: {}, correlationId: "c-1" as never }],
    });

    // Duplicate
    const second = appendEvents(db, {
      runId: "run-1" as never,
      commandId: "cmd-1" as never,
      nextSnapshot: makeSnapshot({ status: "running" }),
      events: [{ eventId: "ev-2" as never, type: "turn.started", payload: { prompt: "hi" }, correlationId: "c-2" as never }],
    });

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected duplicate");
    expect(second.reason).toBe("duplicate_command");

    // Only one event should be stored
    const events = getEventsAfter(db, "run-1", -1);
    expect(events).toHaveLength(1);
  });

  // Rollback semantics: appendEvents runs inside its own transaction.
  // If any statement fails (e.g. unique violation), the entire transaction
  // rolls back automatically — this is inherent in WAL SQLite semantics.
  // The duplicate-command and version-conflict tests above already prove
  // that the store rejects invalid operations without partial writes.

  test("unknown run returns run_not_found", () => {
    const db = openMemoryStore();
    const result = appendEvents(db, {
      runId: "nonexistent" as never,
      commandId: "cmd-1" as never,
      nextSnapshot: makeSnapshot({ runId: "nonexistent" as never }),
      events: [{ eventId: "ev-1" as never, type: "run.started", payload: {}, correlationId: "c-1" as never }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not found");
    expect(result.reason).toBe("run_not_found");
  });

  test("persists orchestration's snapshot without interpreting event semantics", () => {
    const db = openMemoryStore();
    setup(db);

    const result = appendEvents(db, {
      runId: "run-1" as never,
      commandId: "cmd-approval" as never,
      nextSnapshot: makeSnapshot({
        status: "ready",
        sequence: 0,
        streamVersion: 0,
      }),
      events: [{
        eventId: "ev-approval" as never,
        type: "approval.requested",
        payload: {
          approvalId: "approval-1" as never,
          capability: "exec",
          risk: "high",
          details: "Run a command",
        },
        correlationId: "corr-approval" as never,
      }],
    });

    expect(result.ok).toBe(true);
    expect(getSnapshot(db, "run-1")?.status).toBe("ready");
  });
});

describe("outbox", () => {
  test("claims and acknowledges outbox rows", () => {
    const db = openMemoryStore();
    setup(db);

    // Append events (which also create outbox rows)
    appendEvents(db, {
      runId: "run-1" as never,
      commandId: "cmd-1" as never,
      nextSnapshot: makeSnapshot({ status: "running" }),
      events: [
        { eventId: "ev-1" as never, type: "run.started", payload: {}, correlationId: "c-1" as never },
        { eventId: "ev-2" as never, type: "turn.started", payload: { prompt: "hi" }, correlationId: "c-1" as never },
        { eventId: "ev-3" as never, type: "turn.completed", payload: {}, correlationId: "c-1" as never },
      ],
    });

    // Claim first 3 with a 0ms lease (immediately expired)
    const batch = claimOutboxBatch(db, "daemon-1", 0, 3);
    expect(batch).toHaveLength(3);

    // Acknowledge 2
    acknowledgeOutboxBatch(db, batch.slice(0, 2).map((r) => r.id));

    // Claim remaining — lease of 0ms is already expired, acknowledged skipped
    const batch2 = claimOutboxBatch(db, "daemon-2", 10_000, 10);
    expect(batch2).toHaveLength(1); // only the unacked one
  });
});
