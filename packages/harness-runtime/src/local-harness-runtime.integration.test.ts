import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { LocalHarnessRuntime } from "./local-harness-runtime";
import {
  replayRunFromEvents,
  type CanonicalEvent,
  type RunSnapshot,
} from "@relay/contracts";
import { createDeterministicProviderReactor } from "@relay/orchestration";
import { getEventsAfter, openStore } from "@relay/local-store";

// ---------------------------------------------------------------------------
// Conformance suite re-run against the LOCAL implementation.
// (The full contract suite already passes against the fake; these are the
// same tests adapted to the local store-backed implementation.)
// ---------------------------------------------------------------------------

function rt() {
  return LocalHarnessRuntime.memory();
}

async function collectEventsThroughCurrentSequence(
  runtime: LocalHarnessRuntime,
  runId: RunSnapshot["runId"],
  afterSequence = -1,
): Promise<Array<{ type: string; sequence: number; turnId?: string }>> {
  const { sequence } = await runtime.snapshot({ runId });
  if (sequence <= afterSequence) return [];
  const events: Array<{ type: string; sequence: number; turnId?: string }> = [];

  for await (const event of runtime.observe({ runId, afterSequence })) {
    events.push({
      type: event.type,
      sequence: event.sequence,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    });
    if (event.sequence >= sequence) break;
  }

  return events;
}

describe("LocalHarnessRuntime conformance", () => {
  test("creates a run and returns a created snapshot", async () => {
    const h = rt();
    const snap = await h.createRun({ projectId: "test" });
    expect(snap.runId).toBeString();
    expect(snap.status).toBe("ready");
    expect(snap.sequence).toBeGreaterThan(0);
  });

  test("sends a turn and receives a turn receipt", async () => {
    const h = rt();
    const snap = await h.createRun({ projectId: "test" });
    await h.resumeRun({ runId: snap.runId });
    const receipt = await h.sendTurn({ runId: snap.runId, prompt: "hello" });
    expect(receipt.turnId).toBeString();
    expect(receipt.commandId).toBeString();
  });

  test("submitting a turn does not invent provider output", async () => {
    const h = rt();
    const snap = await h.createRun({ projectId: "test" });
    await h.resumeRun({ runId: snap.runId });
    await h.sendTurn({ runId: snap.runId, prompt: "hello" });

    const events = await collectEventsThroughCurrentSequence(h, snap.runId);

    expect(events.map((event) => event.type)).toContain("turn.started");
    expect(events.map((event) => event.type)).not.toContain("assistant.delta");
    expect(events.map((event) => event.type)).not.toContain("assistant.completed");
    expect(events.map((event) => event.type)).not.toContain("turn.completed");
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.sequence).toBeGreaterThan(events[i - 1]!.sequence);
    }
  });

  test("shutdown aborts active reactors, waits for settlement, and fences admission", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let reactorSettled = false;
    const h = LocalHarnessRuntime.memory({
      maxConcurrentRuns: 1,
      reactors: {
        "provider.send_turn": {
          execute: async (_effect, context) => {
            markStarted();
            await new Promise<never>((_resolve, reject) => {
              context.signal.addEventListener(
                "abort",
                () => reject(context.signal.reason),
                { once: true },
              );
            });
            return [];
          },
          recover: async () => [],
        },
      },
    });
    const created = await h.createRun({ projectId: "shutdown-test" });
    await h.resumeRun({ runId: created.runId });
    await h.sendTurn({ runId: created.runId, prompt: "wait" });
    const drain = h.drainEffects().finally(() => {
      reactorSettled = true;
    });
    await started;

    const shutdown = h.shutdown();
    await expect(
      h.steerTurn({ runId: created.runId, steering: "too late" }),
    ).rejects.toThrow("closed");
    await Promise.all([drain, shutdown]);
    expect(reactorSettled).toBe(true);
  });

  test("steering injects a turn.steered event", async () => {
    const h = rt();
    const snap = await h.createRun({ projectId: "test" });
    await h.resumeRun({ runId: snap.runId });
    await h.sendTurn({ runId: snap.runId, prompt: "hello" });
    await h.steerTurn({ runId: snap.runId, steering: "go left" });

    const events = await collectEventsThroughCurrentSequence(h, snap.runId);
    expect(events.map((event) => event.type)).toContain("turn.steered");
  });

  test("provider events update run state through the canonical reducer", async () => {
    const h = rt();
    const snap = await h.createRun({ projectId: "test" });
    await h.resumeRun({ runId: snap.runId });

    await h.appendEvent(snap.runId, {
      eventId: "ev-approval-requested",
      type: "approval.requested",
      payload: {
        approvalId: "approval-1" as never,
        capability: "exec",
        risk: "high",
        details: "Run a command",
      },
    });

    expect((await h.snapshot({ runId: snap.runId })).status).toBe("awaiting_approval");

    await h.appendEvent(snap.runId, {
      eventId: "ev-approval-resolved",
      type: "approval.resolved",
      payload: {
        approvalId: "approval-1" as never,
        resolution: "allow",
      },
    });

    expect((await h.snapshot({ runId: snap.runId })).status).toBe("running");
  });

  test("rejects malformed provider events without quarantining a healthy run", async () => {
    const h = rt();
    const created = await h.createRun({ projectId: "ingress-test" });
    await h.resumeRun({ runId: created.runId });
    const before = await h.snapshot({ runId: created.runId });

    const unknown = await h.appendEvent(created.runId, {
      eventId: "ev-unknown-provider-type",
      type: "provider.native.secret",
      payload: {},
    } as never);
    const malformed = await h.appendEvent(created.runId, {
      eventId: "ev-malformed-usage",
      type: "usage.recorded",
      payload: {
        inputTokens: -1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        modelId: "test",
      },
    });

    expect(unknown.ok).toBe(false);
    expect(malformed.ok).toBe(false);
    expect(await h.snapshot({ runId: created.runId })).toEqual(before);
    expect(h.listRunDiagnostics(created.runId)).toHaveLength(0);
  });

  test("observation stays open and yields events appended after subscription", async () => {
    const h = rt();
    const snap = await h.createRun({ projectId: "test" });
    await h.resumeRun({ runId: snap.runId });
    const current = await h.snapshot({ runId: snap.runId });
    const iterator = h
      .observe({ runId: snap.runId, afterSequence: current.sequence })
      [Symbol.asyncIterator]();
    const nextEvent = iterator.next();

    await h.appendEvent(snap.runId, {
      eventId: "ev-live-usage",
      type: "usage.recorded",
      payload: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        modelId: "live",
      },
    });

    expect(await nextEvent).toMatchObject({
      done: false,
      value: {
        eventId: "ev-live-usage",
        type: "usage.recorded",
      },
    });

    await iterator.return?.();
  });

  test("observation can be cancelled while waiting for the next event", async () => {
    const h = rt();
    const snap = await h.createRun({ projectId: "test" });
    const current = await h.snapshot({ runId: snap.runId });
    const controller = new AbortController();
    const iterator = h
      .observe({
        runId: snap.runId,
        afterSequence: current.sequence,
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    const nextEvent = iterator.next();

    controller.abort();

    expect(await nextEvent).toEqual({ done: true, value: undefined });
    h.close();
  });

  test("stopping transitions to stopping", async () => {
    const h = rt();
    const snap = await h.createRun({ projectId: "test" });
    await h.resumeRun({ runId: snap.runId });
    await h.stopRun({ runId: snap.runId });

    const s = await h.snapshot({ runId: snap.runId });
    expect(["stopping", "stopped"]).toContain(s.status);
  });

  test("snapshot returns the current state", async () => {
    const h = rt();
    const snap = await h.createRun({ projectId: "test" });
    const s = await h.snapshot({ runId: snap.runId });
    expect(s.runId).toBe(snap.runId);
  });

  test("rejects a second turn until the active turn is terminal", async () => {
    const h = rt();
    const snap = await h.createRun({ projectId: "test" });
    await h.resumeRun({ runId: snap.runId });

    const r1 = await h.sendTurn({ runId: snap.runId, prompt: "hello" });
    await expect(
      h.sendTurn({ runId: snap.runId, prompt: "overlap" }),
    ).rejects.toThrow(`turn ${r1.turnId} is still active`);

    const events = await collectEventsThroughCurrentSequence(h, snap.runId);
    const turnStarts = events.filter((e) => e.type === "turn.started");
    expect(turnStarts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Restart recovery — the defining kernel test.
// ---------------------------------------------------------------------------

describe("restart recovery", () => {
  test("durable canonical history replays to the persisted snapshot", async () => {
    const tmpPath = `/tmp/relay-replay-${crypto.randomUUID()}.sqlite`;
    const h = LocalHarnessRuntime.open(tmpPath);
    const created = await h.createRun({
      projectId: "replay-project",
      permissionProfile: "read-only",
    });
    await h.resumeRun({ runId: created.runId });
    const turn = await h.sendTurn({
      runId: created.runId,
      prompt: "replay this",
    });
    await h.appendEvent(created.runId, {
      eventId: "ev-replay-delta",
      type: "assistant.delta",
      turnId: turn.turnId,
      payload: { text: "durable" },
    });
    await h.appendEvent(created.runId, {
      eventId: "ev-replay-complete",
      type: "turn.completed",
      turnId: turn.turnId,
      payload: {},
    });
    const persistedSnapshot = await h.snapshot({ runId: created.runId });
    h.close();

    const db = openStore(tmpPath);
    const events = getEventsAfter(db, created.runId, -1);
    expect(replayRunFromEvents(events as CanonicalEvent[])).toEqual(
      persistedSnapshot,
    );
    db.close();
    try {
      require("node:fs").unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup on platforms that retain SQLite sidecars.
    }
  });

  test("a corrupt persisted snapshot is quarantined into one failed diagnostic", async () => {
    const tmpPath = `/tmp/relay-corrupt-snapshot-${crypto.randomUUID()}.sqlite`;
    const h1 = LocalHarnessRuntime.open(tmpPath);
    const created = await h1.createRun({ projectId: "test" });
    await h1.resumeRun({ runId: created.runId });
    h1.close();

    const raw = new Database(tmpPath);
    raw.run(
      "UPDATE run_snapshots SET payload_json = ? WHERE run_id = ?",
      ["{not-json", created.runId],
    );
    raw.close();

    const h2 = LocalHarnessRuntime.open(tmpPath);
    const quarantined = await h2.snapshot({ runId: created.runId });
    expect(quarantined.status).toBe("failed");
    expect(quarantined.activeTurnId).toBeUndefined();
    expect(h2.listRunDiagnostics(created.runId)).toEqual([
      expect.objectContaining({
        kind: "persisted_record_corrupt",
        message: expect.stringContaining("Invalid JSON in persisted run snapshot"),
      }),
    ]);
    h2.close();

    const h3 = LocalHarnessRuntime.open(tmpPath);
    expect((await h3.snapshot({ runId: created.runId })).status).toBe("failed");
    expect(h3.listRunDiagnostics(created.runId)).toHaveLength(1);
    h3.close();
    try { require("node:fs").unlinkSync(tmpPath); } catch { /* ok */ }
  });

  test("a transient reactor failure waits for its durable retry time", async () => {
    let now = Date.now();
    let executions = 0;
    let recoveries = 0;
    const deterministic = createDeterministicProviderReactor({
      text: "recovered after backoff",
    });
    const h = LocalHarnessRuntime.memory({
      reactorNow: () => now,
      reactorRetryBaseMs: 100,
      reactorRetryJitterRatio: 0,
      reactors: {
        "provider.send_turn": {
          execute: async () => {
            executions++;
            throw new Error("provider temporarily unavailable");
          },
          recover: async (effect, context) => {
            recoveries++;
            return deterministic.recover(effect, context);
          },
        },
      },
    });
    const snap = await h.createRun({ projectId: "test" });
    await h.resumeRun({ runId: snap.runId });
    await h.sendTurn({ runId: snap.runId, prompt: "retry later" });

    expect(await h.drainEffects()).toBe(0);
    expect(executions).toBe(1);
    expect(recoveries).toBe(0);
    expect(await h.drainEffects()).toBe(0);
    expect(executions).toBe(1);
    expect(recoveries).toBe(0);

    now += 99;
    expect(await h.drainEffects()).toBe(0);
    expect(recoveries).toBe(0);

    now += 1;
    expect(await h.drainEffects()).toBe(1);
    expect(recoveries).toBe(1);
    expect((await h.snapshot({ runId: snap.runId })).activeTurnId).toBeUndefined();
    h.close();
  });

  test("a durable retry wakes without an external polling drain", async () => {
    let recoverStarted!: () => void;
    const recovered = new Promise<void>((resolve) => {
      recoverStarted = resolve;
    });
    const deterministic = createDeterministicProviderReactor({
      text: "automatic recovery",
    });
    const h = LocalHarnessRuntime.memory({
      reactorRetryBaseMs: 5,
      reactorRetryMaxMs: 5,
      reactorRetryJitterRatio: 0,
      reactors: {
        "provider.send_turn": {
          execute: async () => {
            throw new Error("transient");
          },
          recover: async (effect, context) => {
            recoverStarted();
            return deterministic.recover(effect, context);
          },
        },
      },
    });
    const snap = await h.createRun({ projectId: "test" });
    await h.resumeRun({ runId: snap.runId });
    await h.sendTurn({ runId: snap.runId, prompt: "wake automatically" });

    expect(await h.drainEffects()).toBe(0);
    await Promise.race([
      recovered,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("retry scheduler did not wake")), 500);
      }),
    ]);
    await h.drainEffects();
    expect((await h.snapshot({ runId: snap.runId })).activeTurnId).toBeUndefined();
    h.close();
  });

  test("an exhausted provider reactor emits a terminal failure command", async () => {
    let executions = 0;
    const h = LocalHarnessRuntime.memory({
      reactorMaxAttempts: 1,
      reactors: {
        "provider.send_turn": {
          execute: async () => {
            executions++;
            throw new Error("provider unavailable");
          },
          recover: async () => {
            executions++;
            throw new Error("provider unavailable");
          },
        },
      },
    });
    const snap = await h.createRun({ projectId: "test" });
    await h.resumeRun({ runId: snap.runId });
    const receipt = await h.sendTurn({
      runId: snap.runId,
      prompt: "fail truthfully",
    });

    expect(await h.drainEffects()).toBe(0);
    expect(await h.drainEffects()).toBe(0);
    expect(executions).toBe(1);
    expect((await h.snapshot({ runId: snap.runId })).activeTurnId).toBeUndefined();
    const terminalSequence = (await h.snapshot({ runId: snap.runId })).sequence;
    let failurePayload: unknown;
    for await (const event of h.observe({ runId: snap.runId })) {
      if (event.type === "turn.failed" && event.turnId === receipt.turnId) {
        failurePayload = event.payload;
      }
      if (event.sequence >= terminalSequence) break;
    }
    expect(failurePayload).toEqual({
      error:
        "provider.send_turn retryable failure after 1 attempt(s): provider unavailable",
    });
    const events = await collectEventsThroughCurrentSequence(h, snap.runId);
    expect(
      events.filter(
        (event) =>
          event.type === "turn.failed" && event.turnId === receipt.turnId,
      ),
    ).toHaveLength(1);
    h.close();
  });

  test("a durable provider effect is reclaimed and completed exactly once", async () => {
    const tmpPath = `/tmp/relay-reactor-recovery-${crypto.randomUUID()}.sqlite`;
    const h1 = LocalHarnessRuntime.open(tmpPath);
    const snap = await h1.createRun({ projectId: "test" });
    await h1.resumeRun({ runId: snap.runId });
    await h1.sendTurn({
      runId: snap.runId,
      prompt: "survive the crash",
      commandId: "cmd-reactor-recovery" as never,
      turnId: "turn-reactor-recovery" as never,
    });
    expect(
      (await collectEventsThroughCurrentSequence(h1, snap.runId))
        .map((event) => event.type),
    ).not.toContain("assistant.completed");
    h1.close();

    let executions = 0;
    const deterministic = createDeterministicProviderReactor({
      text: "recovered output",
    });
    const h2 = LocalHarnessRuntime.open(tmpPath, {
      reactors: {
        "provider.send_turn": {
          execute: async (effect, context) => {
            executions++;
            return deterministic.execute(effect, context);
          },
          recover: deterministic.recover,
        },
      },
    });

    expect(await h2.drainEffects()).toBe(1);
    expect(await h2.drainEffects()).toBe(0);
    expect(executions).toBe(1);

    const events = await collectEventsThroughCurrentSequence(h2, snap.runId);
    expect(events.map((event) => event.type)).toContain("assistant.completed");
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect((await h2.snapshot({ runId: snap.runId })).activeTurnId).toBeUndefined();

    h2.close();
    try { require("node:fs").unlinkSync(tmpPath); } catch { /* ok */ }
  });

  test("a turn receipt and its identity survive restart and redelivery", async () => {
    const tmpPath = `/tmp/relay-turn-receipt-${crypto.randomUUID()}.sqlite`;
    const commandId = "cmd-durable-turn" as never;
    const turnId = "turn-durable-turn" as never;
    const h1 = LocalHarnessRuntime.open(tmpPath);
    const snap = await h1.createRun({ projectId: "test" });
    await h1.resumeRun({ runId: snap.runId });

    const original = await h1.sendTurn({
      runId: snap.runId,
      prompt: "durable",
      commandId,
      turnId,
    });
    expect(original).toEqual({ commandId, turnId });
    expect((await h1.snapshot({ runId: snap.runId })).activeTurnId).toBe(turnId);
    h1.close();

    const h2 = LocalHarnessRuntime.open(tmpPath);
    const redelivered = await h2.sendTurn({
      runId: snap.runId,
      prompt: "durable",
      commandId,
      turnId,
    });
    expect(redelivered).toEqual(original);

    const events = await collectEventsThroughCurrentSequence(h2, snap.runId);
    expect(events.filter((event) => event.type === "turn.started")).toEqual([
      expect.objectContaining({ turnId }),
    ]);

    h2.close();
    try { require("node:fs").unlinkSync(tmpPath); } catch { /* ok */ }
  });

  test("an observer sees commits made through another runtime connection", async () => {
    const tmpPath = `/tmp/relay-cross-runtime-test-${crypto.randomUUID()}.sqlite`;
    const h1 = LocalHarnessRuntime.open(tmpPath);
    const snap = await h1.createRun({ projectId: "test" });
    const current = await h1.snapshot({ runId: snap.runId });
    const h2 = LocalHarnessRuntime.open(tmpPath);
    const iterator = h1
      .observe({ runId: snap.runId, afterSequence: current.sequence })
      [Symbol.asyncIterator]();
    const nextEvent = iterator.next();

    await h2.appendEvent(snap.runId, {
      eventId: "ev-cross-runtime",
      type: "usage.recorded",
      payload: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        modelId: "cross-runtime",
      },
    });

    expect(await nextEvent).toMatchObject({
      done: false,
      value: {
        eventId: "ev-cross-runtime",
        type: "usage.recorded",
      },
    });

    await iterator.return?.();
    h1.close();
    h2.close();
    try { require("node:fs").unlinkSync(tmpPath); } catch { /* ok */ }
  });

  test("run survives close and reopen, resumes from last sequence", async () => {
    // Use in-memory but simulate close/reopen with a temp file
    const tmpPath = `/tmp/relay-recovery-test-${Date.now()}.sqlite`;
    const h1 = LocalHarnessRuntime.open(tmpPath);

    const snap = await h1.createRun({ projectId: "test" });
    await h1.resumeRun({ runId: snap.runId });
    await h1.sendTurn({ runId: snap.runId, prompt: "before restart" });

    // Observe to mid-point
    const midEvents = await collectEventsThroughCurrentSequence(h1, snap.runId);
    expect(midEvents.length).toBeGreaterThanOrEqual(3);

    // Close (simulate crash)
    h1.close();

    // Reopen and resume
    const h2 = LocalHarnessRuntime.open(tmpPath);
    const afterSeq = midEvents[midEvents.length - 1]!.sequence;

    // Can still send a turn after recovery
    await h2.resumeRun({ runId: snap.runId });
    const resumed = await collectEventsThroughCurrentSequence(h2, snap.runId, afterSeq);

    // The events we already saw should NOT appear.
    for (const event of resumed) {
      expect(event.sequence).toBeGreaterThan(afterSeq);
    }

    // The snapshot is intact
    const final = await h2.snapshot({ runId: snap.runId });
    expect(final.sequence).toBeGreaterThanOrEqual(midEvents[midEvents.length - 1]!.sequence);

    h2.close();
    // Clean up
    try { require("node:fs").unlinkSync(tmpPath); } catch { /* ok */ }
  });
});
