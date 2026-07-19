import { describe, expect, test } from "bun:test";
import { getEventsAfter, openMemoryStore } from "@relay/local-store";
import { OrchestrationEngine } from "./orchestration-engine";

describe("OrchestrationEngine durability", () => {
  test("creates the snapshot, event, outbox row, and receipt atomically", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });

    const snapshot = await engine.createRun({ projectId: "project-1" });

    expect(snapshot.status).toBe("ready");
    expect(getEventsAfter(db, snapshot.runId, -1).map((event) => event.type)).toEqual([
      "run.created",
    ]);
    expect(
      db.query("SELECT COUNT(*) AS count FROM command_receipts WHERE run_id = ?")
        .get(snapshot.runId),
    ).toEqual({ count: 1 });
    expect(
      db.query("SELECT COUNT(*) AS count FROM projection_outbox WHERE run_id = ?")
        .get(snapshot.runId),
    ).toEqual({ count: 1 });
  });

  test("returns the original receipt before re-deciding a duplicate command", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });
    const created = await engine.createRun({ projectId: "project-1" });
    const resume = {
      commandId: "cmd-resume-fixed" as never,
      type: "run.resume" as const,
      runId: created.runId,
      correlationId: "corr-resume-fixed" as never,
      actor: { kind: "system" as const, id: "test" },
      issuedAt: 10,
      payload: {},
    };
    await engine.submit(resume);
    const stop = {
      commandId: "cmd-stop-fixed" as never,
      type: "run.stop" as const,
      runId: created.runId,
      correlationId: "corr-stop-fixed" as never,
      actor: { kind: "user" as const, id: "test" },
      issuedAt: 20,
      payload: { reason: "user" },
    };

    const first = await engine.submit(stop);
    const duplicate = await engine.submit(stop);

    expect(duplicate).toEqual(first);
    expect(
      getEventsAfter(db, created.runId, -1)
        .filter((event) => event.type === "run.stopping" || event.type === "run.stopped"),
    ).toHaveLength(2);
  });

  test("drains every queued command for one run in FIFO order", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });
    const created = await engine.createRun({ projectId: "project-1" });

    const resume = engine.submit({
      commandId: "cmd-resume-queued" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-queued" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 10,
      payload: {},
    });
    const turn = engine.submit({
      commandId: "cmd-turn-queued" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-queued" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 20,
      payload: { prompt: "hello" },
    });
    const stop = engine.submit({
      commandId: "cmd-stop-queued" as never,
      type: "run.stop",
      runId: created.runId,
      correlationId: "corr-stop-queued" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 30,
      payload: { reason: "user" },
    });

    await Promise.all([resume, turn, stop]);

    expect(
      getEventsAfter(db, created.runId, -1).map((event) => event.type),
    ).toEqual([
      "run.created",
      "run.started",
      "turn.started",
      "run.stopping",
      "run.stopped",
    ]);
  });

  test("rejects a command ID reused for a different run", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 2 });
    const first = await engine.createRun({ projectId: "project-1" });
    const second = await engine.createRun({ projectId: "project-2" });
    const command = {
      commandId: "cmd-cross-run" as never,
      type: "run.resume" as const,
      correlationId: "corr-cross-run" as never,
      actor: { kind: "system" as const, id: "test" },
      issuedAt: 10,
      payload: {},
    };

    await engine.submit({ ...command, runId: first.runId });

    await expect(
      engine.submit({ ...command, runId: second.runId }),
    ).rejects.toThrow("different run");
  });

  test("continues draining a run queue after one command is rejected", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });
    const created = await engine.createRun({ projectId: "project-1" });

    const invalidStop = engine.submit({
      commandId: "cmd-invalid-stop" as never,
      type: "run.stop",
      runId: created.runId,
      correlationId: "corr-invalid-stop" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 10,
      payload: { reason: "user" },
    });
    const validResume = engine.submit({
      commandId: "cmd-resume-after-error" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-after-error" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 20,
      payload: {},
    });

    const results = await Promise.allSettled([invalidStop, validResume]);

    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("fulfilled");
    expect(
      getEventsAfter(db, created.runId, -1).map((event) => event.type),
    ).toEqual(["run.created", "run.started"]);
  });

  test("rolls back initial snapshot when run creation persistence fails", async () => {
    const db = openMemoryStore();
    db.run(`
      CREATE TRIGGER reject_run_event
      BEFORE INSERT ON run_events
      BEGIN
        SELECT RAISE(FAIL, 'injected event failure');
      END
    `);
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });

    await expect(engine.createRun({ projectId: "project-1" })).rejects.toThrow(
      "injected event failure",
    );

    expect(db.query("SELECT COUNT(*) AS count FROM run_snapshots").get()).toEqual({
      count: 0,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual({
      count: 0,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM projection_outbox").get()).toEqual({
      count: 0,
    });
  });
});
