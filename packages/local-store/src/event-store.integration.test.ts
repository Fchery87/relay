import { expect, test, describe } from "bun:test";
import { openMemoryStore, type StoreDatabase } from "./database";
import {
  appendEvents,
  insertSnapshot,
  getSnapshot,
  getEventsAfter,
  transactCommand,
} from "./event-store";
import { claimOutboxBatch, acknowledgeOutboxBatch } from "./outbox";
import {
  claimEffectBatch,
  getEffectsForCommand,
  releaseEffect,
} from "./effect-store";
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
  test("loads and decides within the same SQLite transaction as persistence", () => {
    const db = openMemoryStore();
    setup(db);
    let decidedInsideTransaction = false;

    const result = transactCommand(db, {
      runId: "run-1" as never,
      commandId: "cmd-transaction-boundary" as never,
      decide: (snapshot) => {
        decidedInsideTransaction = db.inTransaction;
        return {
          nextSnapshot: snapshot,
          events: [{
            eventId: "ev-transaction-boundary" as never,
            type: "assistant.delta",
            payload: { text: "atomic" },
            correlationId: "corr-transaction-boundary" as never,
          }],
        };
      },
    });

    expect(decidedInsideTransaction).toBe(true);
    expect(result.ok).toBe(true);
    expect(getEventsAfter(db, "run-1", -1)).toHaveLength(1);
  });

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
          turnId: "turn-1" as never,
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

  test("round-trips complete snapshot and event metadata through versioned records", () => {
    const db = openMemoryStore();
    const snapshot = makeSnapshot({
      projectId: "project-1" as never,
      activeTurnId: "turn-1" as never,
      providerInstanceId: "provider-1" as never,
      permissionProfile: "workspace-write",
      providerSession: {
        providerInstanceId: "provider-1" as never,
        providerThreadId: "thread-1",
      },
      workspace: {
        runId: "run-1" as never,
        repoPath: "/repo",
        worktreePath: "/repo/.relay/run-1",
        baseCommit: "abc123",
        permissionProfile: "workspace-write",
        createdAt: 1,
      },
      checkpoint: {
        checkpointId: "checkpoint-1" as never,
        turnId: "turn-1" as never,
        commit: "def456",
        ref: "refs/relay/checkpoint-1",
        capturedAt: 2,
      },
      reducerPayload: { nested: { attempt: 2 }, values: ["a", true] },
    });
    insertSnapshot(db, snapshot);

    const result = appendEvents(db, {
      runId: snapshot.runId,
      commandId: "cmd-metadata" as never,
      nextSnapshot: snapshot,
      events: [{
        eventId: "ev-metadata" as never,
        type: "assistant.delta",
        payload: { text: "hello" },
        turnId: "turn-1" as never,
        providerInstanceId: "provider-1" as never,
        correlationId: "corr-metadata" as never,
      }],
    });
    expect(result.ok).toBe(true);

    expect(getSnapshot(db, "run-1")).toMatchObject({
      projectId: "project-1",
      activeTurnId: "turn-1",
      providerInstanceId: "provider-1",
      permissionProfile: "workspace-write",
      reducerPayload: { nested: { attempt: 2 }, values: ["a", true] },
    });
    expect(getEventsAfter(db, "run-1", -1)).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        providerInstanceId: "provider-1",
        payload: { text: "hello" },
      }),
    ]);

    const persisted = db
      .query("SELECT payload_json FROM run_snapshots WHERE run_id = ?")
      .get("run-1") as { payload_json: string };
    expect(JSON.parse(persisted.payload_json)).toMatchObject({
      schemaVersion: 1,
      kind: "run_snapshot",
    });
  });

  test("rejects corrupt persisted records instead of casting them", () => {
    const db = openMemoryStore();
    setup(db);
    db.run(
      "UPDATE run_snapshots SET payload_json = ? WHERE run_id = ?",
      [JSON.stringify({ schemaVersion: 99, kind: "run_snapshot", data: {} }), "run-1"],
    );

    expect(() => getSnapshot(db, "run-1")).toThrow(
      "Unsupported persisted schema version",
    );
  });

  test("fails closed when a duplicate command receipt is corrupt", () => {
    const db = openMemoryStore();
    setup(db);
    const input = {
      runId: "run-1" as never,
      commandId: "cmd-corrupt-receipt" as never,
      nextSnapshot: makeSnapshot({ status: "running" }),
      events: [{
        eventId: "ev-corrupt-receipt" as never,
        type: "run.started" as const,
        payload: {},
        correlationId: "corr-corrupt-receipt" as never,
      }],
    };
    expect(appendEvents(db, input).ok).toBe(true);
    db.run(
      "UPDATE command_receipts SET result_json = ? WHERE command_id = ?",
      [JSON.stringify({ schemaVersion: 99 }), input.commandId],
    );

    expect(() => appendEvents(db, input)).toThrow(
      "Unsupported persisted schema version",
    );
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
        { eventId: "ev-2" as never, type: "turn.started", turnId: "turn-1" as never, payload: { prompt: "hi" }, correlationId: "c-1" as never },
        { eventId: "ev-3" as never, type: "turn.completed", turnId: "turn-1" as never, payload: {}, correlationId: "c-1" as never },
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

describe("effect outbox", () => {
  test("claims effects in durable insertion order when timestamps tie", () => {
    const db = openMemoryStore();
    setup(db);
    appendEvents(db, {
      runId: "run-1" as never,
      commandId: "cmd-effects-1" as never,
      nextSnapshot: makeSnapshot({ status: "ready" }),
      events: [],
      effects: [
        {
          effectId: "effect-1-0" as never,
          runId: "run-1" as never,
          commandId: "cmd-effects-1" as never,
          effectIndex: 0,
          intent: { kind: "provider.stop_session" },
          retryClass: "transient",
        },
        {
          effectId: "effect-1-1" as never,
          runId: "run-1" as never,
          commandId: "cmd-effects-1" as never,
          effectIndex: 1,
          intent: { kind: "provider.stop_session" },
          retryClass: "transient",
        },
      ],
    });
    appendEvents(db, {
      runId: "run-1" as never,
      commandId: "cmd-effects-2" as never,
      nextSnapshot: makeSnapshot({ status: "ready" }),
      events: [],
      effects: [{
        effectId: "effect-2-0" as never,
        runId: "run-1" as never,
        commandId: "cmd-effects-2" as never,
        effectIndex: 0,
        intent: { kind: "provider.stop_session" },
        retryClass: "transient",
      }],
    });
    db.run("UPDATE effect_outbox SET created_at = 1");

    expect(
      claimEffectBatch(db, "worker", 100, 10, 10).map(
        (effect) => effect.effectId as string,
      ),
    ).toEqual(["effect-1-0", "effect-1-1", "effect-2-0"]);
  });

  test("an expired non-retryable effect fails instead of executing twice", () => {
    const db = openMemoryStore();
    setup(db);
    appendEvents(db, {
      runId: "run-1" as never,
      commandId: "cmd-never-retry" as never,
      nextSnapshot: makeSnapshot({ status: "ready" }),
      events: [],
      effects: [{
        effectId: "effect-never-retry" as never,
        runId: "run-1" as never,
        commandId: "cmd-never-retry" as never,
        effectIndex: 0,
        intent: { kind: "tool.execute", toolName: "test", input: {} },
        retryClass: "never",
      }],
    });
    expect(claimEffectBatch(db, "worker-1", 10, 1, 100)).toHaveLength(1);

    const [recovery] = claimEffectBatch(db, "worker-2", 10, 1, 111);
    expect(recovery).toMatchObject({
      attempts: 1,
      recoveryFailure: "Non-retryable effect lease expired",
    });
    releaseEffect(
      db,
      recovery!.effectId,
      "worker-2",
      recovery!.recoveryFailure!,
      true,
      112,
    );
    expect(
      getEffectsForCommand(db, "cmd-never-retry" as never)[0],
    ).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "Non-retryable effect lease expired",
    });
  });
});
