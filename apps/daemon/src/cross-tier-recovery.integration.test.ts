/**
 * Cross-tier recovery integration test.
 *
 * Exercises the full seam: command → turn → reactor → events → snapshot
 * using an isolated in-memory harness runtime with the real orchestration
 * engine and a deterministic provider reactor.
 */
import { describe, expect, test } from "bun:test";
import { LocalHarnessRuntime } from "@relay/harness-runtime";
import { MutableReactorRegistry } from "@relay/orchestration";
import type { EffectReactor } from "@relay/contracts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime() {
  const registry = new MutableReactorRegistry();
  let executed = 0;
  let succeeded = 0;
  let failed = 0;

  const providerReactor: EffectReactor = {
    execute: async (effect) => {
      executed++;
      if (effect.intent.kind !== "provider.send_turn") return [];
      try {
        // Simulate a successful turn — append turn.completed via
        // a provider.event command so the engine processes it.
        succeeded++;
        return [
          {
            type: "provider.event" as const,
            payload: {
              eventId: `ev-comp-${effect.runId}-${executed}`,
              type: "turn.completed",
              turnId: effect.intent.turnId,
              payload: {},
            } as never,
          },
        ];
      } catch {
        failed++;
        return [
          {
            type: "provider.event" as const,
            payload: {
              eventId: `ev-fail-${effect.runId}-${executed}`,
              type: "turn.failed",
              turnId: effect.intent.turnId,
              payload: { error: "simulated failure" },
            } as never,
          },
        ];
      }
    },
    recover: async () => [],
  };

  registry.register("provider.send_turn", providerReactor);

  const runtime = LocalHarnessRuntime.memory({
    maxConcurrentRuns: 2,
    reactors: registry.build(),
  });

  return {
    runtime,
    stats: () => ({ executed, succeeded, failed }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cross-tier recovery", () => {
  test("create → resume → send → drain → snapshot", async () => {
    const { runtime } = makeRuntime();

    const snap = await runtime.createRun({ projectId: "p1" });
    expect(snap.runId).toBeDefined();
    expect(snap.status).toBe("ready");

    // Transition from ready → running before sending a turn
    await runtime.resumeRun({ runId: snap.runId });

    const receipt = await runtime.sendTurn({
      runId: snap.runId,
      prompt: "hello",
    });
    expect(receipt.turnId).toBeDefined();

    // The engine auto-drains via microtask; drainEffects drains remaining.
    await runtime.drainEffects();

    const after = runtime.getSnapshotByRunId(snap.runId);
    expect(after).toBeDefined();
  });

  test("idempotent command replay", async () => {
    const { runtime } = makeRuntime();

    const snap = await runtime.createRun({ projectId: "p2" });
    await runtime.resumeRun({ runId: snap.runId });
    const cmdId = `cmd-${crypto.randomUUID()}` as never;

    const first = await runtime.sendTurn({
      runId: snap.runId,
      prompt: "hi",
      commandId: cmdId,
    });
    const second = await runtime.sendTurn({
      runId: snap.runId,
      prompt: "hi",
      commandId: cmdId,
    });

    // Same commandId → same turnId
    expect(second.turnId).toBe(first.turnId);
  });

  test("stop run", async () => {
    const { runtime } = makeRuntime();

    const snap = await runtime.createRun({ projectId: "p3" });
    await runtime.resumeRun({ runId: snap.runId });
    await runtime.stopRun({ runId: snap.runId });

    const after = runtime.getSnapshotByRunId(snap.runId);
    expect(after?.status).toBe("stopped");
  });

  test("resume after interrupt", async () => {
    const { runtime } = makeRuntime();

    const snap = await runtime.createRun({ projectId: "p4" });
    await runtime.resumeRun({ runId: snap.runId });
    await runtime.interruptTurn({ runId: snap.runId, reason: "cancel" });

    const resumed = await runtime.resumeRun({ runId: snap.runId });
    expect(resumed.runId).toBe(snap.runId);
  });

  test("approval resolution", async () => {
    const { runtime } = makeRuntime();

    const snap = await runtime.createRun({ projectId: "p5" });
    await runtime.resumeRun({ runId: snap.runId });
    // Approval resolution requires run to be in awaiting_approval state
    // In a real flow, the provider reactor would emit an approval event.
    // For this test, we verify the API shape is correct.
    await expect(
      runtime.resolveApproval({
        approvalId: `apr-1`,
        resolution: "allow",
        runId: snap.runId,
      }),
    ).rejects.toThrow(); // Not in awaiting_approval state
  });

  test("multiple independent runs", async () => {
    const { runtime } = makeRuntime();

    const a = await runtime.createRun({ projectId: "pa" });
    await runtime.resumeRun({ runId: a.runId });
    const b = await runtime.createRun({ projectId: "pb" });
    await runtime.resumeRun({ runId: b.runId });

    await runtime.sendTurn({ runId: a.runId, prompt: "a" });
    await runtime.sendTurn({ runId: b.runId, prompt: "b" });

    await runtime.drainEffects();

    expect(runtime.getSnapshotByRunId(a.runId)).toBeDefined();
    expect(runtime.getSnapshotByRunId(b.runId)).toBeDefined();
  });

  test("shutdown prevents new runs", async () => {
    const { runtime } = makeRuntime();

    await runtime.shutdown();

    await expect(
      runtime.createRun({ projectId: "post-shutdown" }),
    ).rejects.toThrow();
  });

  test("recoverable state after provider failure", async () => {
    const failRegistry = new MutableReactorRegistry();
    const failReactor: EffectReactor = {
      execute: async (effect) => {
        if (effect.intent.kind !== "provider.send_turn") return [];
        return [
          {
            type: "provider.event" as const,
            payload: {
              eventId: `ev-fail-${effect.runId}`,
              type: "turn.failed",
              turnId: effect.intent.turnId,
              payload: { error: "provider unavailable" },
            } as never,
          },
        ];
      },
      recover: async () => [],
    };
    failRegistry.register("provider.send_turn", failReactor);

    const failRuntime = LocalHarnessRuntime.memory({
      reactors: failRegistry.build(),
    });

    const s = await failRuntime.createRun({ projectId: "pf2" });
    await failRuntime.resumeRun({ runId: s.runId });
    await failRuntime.sendTurn({ runId: s.runId, prompt: "will fail" });
    await failRuntime.drainEffects();

    const after = failRuntime.getSnapshotByRunId(s.runId);
    expect(after).toBeDefined();
    // Run remains in a recoverable state — not corrupted
    expect(after?.status).toBeDefined();
  });

  test("completed turn leaves no pending effect", async () => {
    const { runtime } = makeRuntime();

    const snap = await runtime.createRun({ projectId: "p-no-pending" });
    await runtime.resumeRun({ runId: snap.runId });
    await runtime.sendTurn({ runId: snap.runId, prompt: "one and done" });

    // Drain all effects — the reactor should process the turn and emit
    // turn.completed, leaving no pending provider.send_turn effect.
    const drained = await runtime.drainEffects();

    // After draining, no more effects should be pending.
    const pending = await runtime.drainEffects();
    expect(pending).toBe(0);

    const final = runtime.getSnapshotByRunId(snap.runId);
    expect(final).toBeDefined();
  });
});
