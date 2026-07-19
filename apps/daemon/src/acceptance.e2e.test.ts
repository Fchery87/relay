// ---------------------------------------------------------------------------
// Production acceptance suite — exercises all 25 canonical event types
// through the full kernel daemon path using deterministic fakes.
// ---------------------------------------------------------------------------

import { expect, test, describe } from "bun:test";
import {
  LocalHarnessRuntime,
  type AppendEventInput,
} from "@relay/harness-runtime";

describe("Production acceptance — all 25 canonical event types", () => {
  test("run lifecycle: created, started, stopping, stopped", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const snap = await runtime.createRun({ projectId: "proj-1" });
    expect(snap.status).toBe("ready");

    const events = await collectEvents(runtime, snap.runId as string);
    expect(types(events)).toContain("run.created");

    await runtime.resumeRun({ runId: snap.runId });
    await runtime.stopRun({ runId: snap.runId, reason: "user" });

    const all = await collectEvents(runtime, snap.runId as string);
    expect(types(all)).toContain("run.stopping");
    expect(types(all)).toContain("run.stopped");
  });

  test("turn lifecycle: started, steered, completed, failed, interrupted", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const snap = await runtime.createRun({ projectId: "proj-2" });
    await runtime.resumeRun({ runId: snap.runId });

    // Send a turn, then simulate explicit provider events.
    await runtime.sendTurn({ runId: snap.runId, prompt: "test" });
    await runtime.appendEvent(snap.runId as string, {
      eventId: "ev-assistant-delta",
      type: "assistant.delta",
      payload: { text: "done" },
    });
    await runtime.appendEvent(snap.runId as string, {
      eventId: "ev-assistant-completed",
      type: "assistant.completed",
      payload: {},
    });
    await runtime.appendEvent(snap.runId as string, {
      eventId: "ev-turn-completed",
      type: "turn.completed",
      payload: { summary: "done" },
    });

    const events = await collectEvents(runtime, snap.runId as string);
    expect(types(events)).toContain("turn.started");
    expect(types(events)).toContain("turn.completed");
    expect(types(events)).toContain("assistant.delta");
    expect(types(events)).toContain("assistant.completed");

    // Steer a turn
    await runtime.steerTurn({ runId: snap.runId, steering: "go faster" });
    const postSteer = await collectEvents(runtime, snap.runId as string);
    expect(types(postSteer)).toContain("turn.steered");

    // Interrupt a turn
    await runtime.interruptTurn({ runId: snap.runId, reason: "user" });
    const postInt = await collectEvents(runtime, snap.runId as string);
    expect(types(postInt)).toContain("turn.interrupted");
  });

  test("activity lifecycle: started, delta, completed, failed", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const snap = await runtime.createRun({ projectId: "proj-3" });
    await runtime.resumeRun({ runId: snap.runId });

    await runtime.appendEvent(snap.runId as string, {
      eventId: `ev-act-start`,
      type: "activity.started",
      payload: { activityId: "act-1" as never, kind: "bash", toolName: "bash" },
    });
    await runtime.appendEvent(snap.runId as string, {
      eventId: `ev-act-delta`,
      type: "activity.delta",
      payload: { activityId: "act-1" as never, content: "npm install" },
    });
    await runtime.appendEvent(snap.runId as string, {
      eventId: `ev-act-done`,
      type: "activity.completed",
      payload: { activityId: "act-1" as never, summary: "installed" },
    });
    await runtime.appendEvent(snap.runId as string, {
      eventId: `ev-act-fail`,
      type: "activity.failed",
      payload: { activityId: "act-1" as never, error: "permission denied" },
    });

    const events = await collectEvents(runtime, snap.runId as string);
    expect(types(events)).toContain("activity.started");
    expect(types(events)).toContain("activity.delta");
    expect(types(events)).toContain("activity.completed");
    expect(types(events)).toContain("activity.failed");
  });

  test("approval lifecycle: requested, resolved", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const snap = await runtime.createRun({ projectId: "proj-4" });
    await runtime.resumeRun({ runId: snap.runId });

    await runtime.appendEvent(snap.runId as string, {
      eventId: `ev-apr-req`,
      type: "approval.requested",
      payload: { approvalId: "apr-1" as never, capability: "exec", risk: "high", details: "rm -rf" },
    });
    await runtime.resolveApproval({
      runId: snap.runId,
      approvalId: "apr-1" as never,
      resolution: "deny",
    });

    const events = await collectEvents(runtime, snap.runId as string);
    expect(types(events)).toContain("approval.requested");
    expect(types(events)).toContain("approval.resolved");
  });

  test("usage recorded", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const snap = await runtime.createRun({ projectId: "proj-5" });
    await runtime.resumeRun({ runId: snap.runId });

    await runtime.appendEvent(snap.runId as string, {
      eventId: `ev-usage`,
      type: "usage.recorded",
      payload: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, thinkingTokens: 20, modelId: "test" },
    });

    const events = await collectEvents(runtime, snap.runId as string);
    expect(types(events)).toContain("usage.recorded");
  });

  test("provider session: started, resumed, stopped", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const snap = await runtime.createRun({ projectId: "proj-6" });
    await runtime.resumeRun({ runId: snap.runId });

    await runtime.appendEvent(snap.runId as string, {
      eventId: `ev-sess-start`,
      type: "provider.session.started",
      payload: { providerInstanceId: "codex" as never, providerThreadId: "thr-1" },
    });
    await runtime.appendEvent(snap.runId as string, {
      eventId: `ev-sess-resume`,
      type: "provider.session.resumed",
      payload: { providerInstanceId: "codex" as never, providerThreadId: "thr-2" },
    });
    await runtime.appendEvent(snap.runId as string, {
      eventId: `ev-sess-stop`,
      type: "provider.session.stopped",
      payload: { providerInstanceId: "codex" as never, reason: "completed" },
    });

    const events = await collectEvents(runtime, snap.runId as string);
    expect(types(events)).toContain("provider.session.started");
    expect(types(events)).toContain("provider.session.resumed");
    expect(types(events)).toContain("provider.session.stopped");
  });

  test("checkpoint and projection events", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const snap = await runtime.createRun({ projectId: "proj-7" });
    await runtime.resumeRun({ runId: snap.runId });

    await runtime.appendEvent(snap.runId as string, {
      eventId: `ev-ckpt-cap`,
      type: "checkpoint.captured",
      payload: { checkpointId: "ckpt-1" as never, commit: "abc123", ref: "refs/relay/ckpt-1" },
    });
    await runtime.appendEvent(snap.runId as string, {
      eventId: `ev-ckpt-restore`,
      type: "checkpoint.restored",
      payload: { checkpointId: "ckpt-1" as never, commit: "abc123" },
    });
    await runtime.appendEvent(snap.runId as string, {
      eventId: `ev-proj-pub`,
      type: "projection.published",
      payload: { cursor: 10 },
    });

    const events = await collectEvents(runtime, snap.runId as string);
    expect(types(events)).toContain("checkpoint.captured");
    expect(types(events)).toContain("checkpoint.restored");
    expect(types(events)).toContain("projection.published");
  });

  test("all 25 canonical event types are producible", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const snap = await runtime.createRun({ projectId: "proj-all" });
    const runId = snap.runId as string;
    await runtime.resumeRun({ runId: snap.runId });

    // Emit all 25 types
    const allTypes: Array<{
      type: AppendEventInput["type"];
      payload: Record<string, unknown>;
    }> = [
      { type: "run.created", payload: { environmentId: "local", projectId: "p" } },
      { type: "run.started", payload: {} },
      { type: "run.stopping", payload: { reason: "user" } },
      { type: "run.stopped", payload: {} },
      { type: "run.failed", payload: { error: "test" } },
      { type: "provider.session.started", payload: { providerInstanceId: "pi", providerThreadId: "thr" } },
      { type: "provider.session.resumed", payload: { providerInstanceId: "pi", providerThreadId: "thr" } },
      { type: "provider.session.stopped", payload: { providerInstanceId: "pi", reason: "completed" } },
      { type: "turn.started", payload: { prompt: "hello" } },
      { type: "turn.steered", payload: { steering: "faster" } },
      { type: "turn.completed", payload: { summary: "done" } },
      { type: "turn.failed", payload: { error: "boom" } },
      { type: "turn.interrupted", payload: { reason: "user" } },
      { type: "assistant.delta", payload: { text: "hi" } },
      { type: "assistant.completed", payload: {} },
      { type: "activity.started", payload: { activityId: "a1" as never, kind: "bash", toolName: "bash" } },
      { type: "activity.delta", payload: { activityId: "a1" as never, content: "npm i" } },
      { type: "activity.completed", payload: { activityId: "a1" as never, summary: "ok" } },
      { type: "activity.failed", payload: { activityId: "a1" as never, error: "no" } },
      { type: "approval.requested", payload: { approvalId: "ap1" as never, capability: "exec", risk: "high", details: "rm" } },
      { type: "approval.resolved", payload: { approvalId: "ap1" as never, resolution: "deny" } },
      { type: "usage.recorded", payload: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, modelId: "t" } },
      { type: "checkpoint.captured", payload: { checkpointId: "ckpt-all" as never, commit: "abc", ref: "refs/relay/ckpt-all" } },
      { type: "checkpoint.restored", payload: { checkpointId: "ckpt-all" as never, commit: "abc" } },
      { type: "projection.published", payload: { cursor: 1 } },
    ];

    const initialOrAlternateTerminal = new Set([
      "run.created",
      "run.started",
      "run.failed",
      "run.stopping",
      "run.stopped",
    ]);
    for (const ev of allTypes) {
      if (initialOrAlternateTerminal.has(ev.type)) continue;
      await runtime.appendEvent(runId, {
        ...ev,
        eventId: `ev-${ev.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      } as AppendEventInput);
    }

    await runtime.appendEvent(runId, {
      eventId: "ev-run-stopping",
      type: "run.stopping",
      payload: { reason: "user" },
    });
    await runtime.appendEvent(runId, {
      eventId: "ev-run-stopped",
      type: "run.stopped",
      payload: {},
    });

    const failedRun = await runtime.createRun({ projectId: "proj-failed" });
    await runtime.resumeRun({ runId: failedRun.runId });
    await runtime.appendEvent(failedRun.runId as string, {
      eventId: "ev-run-failed",
      type: "run.failed",
      payload: { error: "test" },
    });

    const events = [
      ...(await collectEvents(runtime, runId)),
      ...(await collectEvents(runtime, failedRun.runId as string)),
    ];
    const seen = new Set(types(events));
    const expected = new Set(allTypes.map((e) => e.type));

    for (const t of expected) {
      expect(seen.has(t), `Missing canonical event type: ${t}`).toBe(true);
    }
    expect(seen.size).toBe(25);
  });
});

// -- helpers ----------------------------------------------------------------

async function collectEvents(runtime: LocalHarnessRuntime, runId: string) {
  const snapshot = runtime.getSnapshotByRunId(runId);
  if (!snapshot) throw new Error(`Run not found: ${runId}`);
  const events: Array<{ type: string; payload: unknown }> = [];
  for await (const ev of runtime.observe({ runId: runId as never, afterSequence: -1 })) {
    events.push(ev);
    if (ev.sequence >= snapshot.sequence) break;
  }
  return events;
}

function types(events: Array<{ type: string; payload: unknown }>): string[] {
  return events.map((e) => e.type);
}
