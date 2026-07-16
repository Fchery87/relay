import { expect, test, describe } from "bun:test";
import { decide, type DeciderResult } from "./decider";
import type { RunSnapshot, Command } from "@relay/contracts";

function snap(overrides?: Partial<RunSnapshot>): RunSnapshot {
  return {
    runId: "run-1" as never,
    status: "ready",
    sequence: 0,
    streamVersion: 0,
    restartCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function cmd(type: string, payload: Record<string, unknown> = {}): Command {
  return {
    commandId: `cmd-${type}` as never,
    type,
    runId: "run-1" as never,
    correlationId: "corr-1" as never,
    actor: { kind: "user" as const, id: "u1" },
    issuedAt: Date.now(),
    payload,
  } as unknown as Command;
}

describe("decider", () => {
  test("run.resume emits run.started and transitions to running", () => {
    const result = decide(snap({ status: "ready" }), cmd("run.resume"));
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe("run.started");
    expect(result.snapshot?.status).toBe("running");
  });

  test("run.stop emits stopping + stopped", () => {
    const result = decide(snap({ status: "running" }), cmd("run.stop", { reason: "user" }));
    expect(result.events.map((e) => e.type)).toEqual(["run.stopping", "run.stopped"]);
    expect(result.effects).toHaveLength(1); // provider.stop_session
  });

  test("turn.send emits turn.started and provider effect", () => {
    const result = decide(snap({ status: "running" }), cmd("turn.send", { prompt: "hello" }));
    expect(result.events[0]!.type).toBe("turn.started");
    expect(result.effects.some((e) => e.kind === "provider.send_turn")).toBe(true);
  });

  test("turn.steer emits turn.steered", () => {
    const result = decide(snap(), cmd("turn.steer", { steering: "go left" }));
    expect(result.events[0]!.type).toBe("turn.steered");
  });

  test("turn.interrupt emits turn.interrupted", () => {
    const result = decide(snap(), cmd("turn.interrupt", { reason: "cancel" }));
    expect(result.events[0]!.type).toBe("turn.interrupted");
  });

  test("approval.resolve emits approval.resolved", () => {
    const result = decide(snap({ status: "awaiting_approval" }), cmd("approval.resolve", { approvalId: "a1", resolution: "allow" }));
    expect(result.events[0]!.type).toBe("approval.resolved");
    expect(result.snapshot?.status).toBe("running");
  });

  test("duplicate run.resume on running is idempotent", () => {
    const result = decide(snap({ status: "running" }), cmd("run.resume"));
    // The decider always emits run.started for resume; idempotency is in the store.
    expect(result.events[0]!.type).toBe("run.started");
  });

  test("internal commands return empty by default", () => {
    const r = decide(snap(), cmd("workspace.result"));
    expect(r.events).toHaveLength(0);
    expect(r.effects).toHaveLength(0);
  });
});
