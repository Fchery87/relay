import { expect, test, describe } from "bun:test";
import { reduceRun, RunTransitionError, type RunSnapshot } from "./state";

const baseSnapshot = (overrides?: Partial<RunSnapshot>): RunSnapshot => ({
  runId: "run-1" as never,
  status: "created",
  sequence: 0,
  streamVersion: 0,
  restartCount: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

// --- run lifecycle ---

describe("run.created", () => {
  test("created → ready", () => {
    const result = reduceRun(baseSnapshot(), {
      type: "run.created",
      payload: { projectId: "project-1" },
    } as never);
    expect(result?.status).toBe("ready");
    expect(result?.projectId).toBe("project-1" as never);
  });

  test("no-op when already ready", () => {
    expect(
      reduceRun(baseSnapshot({ status: "ready" }), { type: "run.created" } as never),
    ).toBeNull();
  });
});

describe("run.started", () => {
  test("ready → running", () => {
    const result = reduceRun(baseSnapshot({ status: "ready" }), {
      type: "run.started",
    } as never);
    expect(result?.status).toBe("running");
  });

  test("no-op when already running", () => {
    expect(reduceRun(baseSnapshot({ status: "running" }), { type: "run.started" } as never)).toBeNull();
  });

  test("created → running is denied", () => {
    expect(() =>
      reduceRun(baseSnapshot({ status: "created" }), { type: "run.started" } as never),
    ).toThrow(RunTransitionError);
  });
});

describe("run.stopping", () => {
  test("running → stopping", () => {
    const result = reduceRun(baseSnapshot({ status: "running" }), {
      type: "run.stopping",
    } as never);
    expect(result?.status).toBe("stopping");
  });

  test("awaiting_approval → stopping", () => {
    const result = reduceRun(baseSnapshot({ status: "awaiting_approval" }), {
      type: "run.stopping",
    } as never);
    expect(result?.status).toBe("stopping");
  });
});

describe("run.stopped", () => {
  test("stopping → stopped", () => {
    const result = reduceRun(baseSnapshot({ status: "stopping" }), {
      type: "run.stopped",
    } as never);
    expect(result?.status).toBe("stopped");
  });

  test("no-op when already stopped", () => {
    expect(reduceRun(baseSnapshot({ status: "stopped" }), { type: "run.stopped" } as never)).toBeNull();
  });

  test("no-op when already completed (cannot transition to stopped)", () => {
    expect(() =>
      reduceRun(baseSnapshot({ status: "completed" }), { type: "run.stopped" } as never),
    ).toThrow(RunTransitionError);
  });
});

describe("run.failed", () => {
  test("running → failed", () => {
    const result = reduceRun(baseSnapshot({ status: "running" }), {
      type: "run.failed",
    } as never);
    expect(result?.status).toBe("failed");
  });

  test("no-op when already failed", () => {
    expect(reduceRun(baseSnapshot({ status: "failed" }), { type: "run.failed" } as never)).toBeNull();
  });
});

// --- terminal states are truly terminal ---

describe("terminal states", () => {
  const terminals: Array<"stopped" | "completed" | "failed"> = [
    "stopped",
    "completed",
    "failed",
  ];

  for (const status of terminals) {
    test(`${status} cannot transition to running`, () => {
      expect(() =>
        reduceRun(baseSnapshot({ status }), { type: "run.started" } as never),
      ).toThrow(RunTransitionError);
    });
  }
});

// --- approval ---

describe("approval", () => {
  test("running → awaiting_approval", () => {
    const result = reduceRun(baseSnapshot({ status: "running" }), {
      type: "approval.requested",
    } as never);
    expect(result?.status).toBe("awaiting_approval");
  });

  test("awaiting_approval → running on resolved", () => {
    const result = reduceRun(baseSnapshot({ status: "awaiting_approval" }), {
      type: "approval.resolved",
    } as never);
    expect(result?.status).toBe("running");
  });

  test("resolved when already running is no-op", () => {
    expect(reduceRun(baseSnapshot({ status: "running" }), { type: "approval.resolved" } as never)).toBeNull();
  });
});

// --- events that don't change status ---

describe("non-status events", () => {
  const noStatusChange: Array<{ type: string }> = [
    { type: "turn.steered" },
    { type: "provider.session.stopped" },
    { type: "assistant.delta" },
    { type: "assistant.completed" },
    { type: "activity.started" },
    { type: "activity.delta" },
    { type: "activity.completed" },
    { type: "activity.failed" },
    { type: "usage.recorded" },
    { type: "checkpoint.restored" },
    { type: "projection.published" },
  ];

  for (const { type } of noStatusChange) {
    test(`${type} does not change run status`, () => {
      expect(reduceRun(baseSnapshot({ status: "running" }), { type } as never)).toBeNull();
      expect(reduceRun(baseSnapshot({ status: "ready" }), { type } as never)).toBeNull();
    });
  }
});

describe("run metadata", () => {
  test("turn lifecycle owns activeTurnId", () => {
    const started = reduceRun(baseSnapshot({ status: "running" }), {
      type: "turn.started",
      turnId: "turn-1",
      occurredAt: 2,
      payload: { prompt: "hello" },
    } as never);
    expect(started?.activeTurnId).toBe("turn-1" as never);

    const completed = reduceRun(
      baseSnapshot({ status: "running", activeTurnId: "turn-1" as never }),
      {
        type: "turn.completed",
        turnId: "turn-1",
        occurredAt: 3,
        payload: {},
      } as never,
    );
    expect(completed).toMatchObject({ activeTurnId: undefined });
  });

  test("provider session metadata is reduced into the snapshot", () => {
    const result = reduceRun(baseSnapshot({ status: "running" }), {
      type: "provider.session.started",
      occurredAt: 2,
      payload: {
        providerInstanceId: "provider-1",
        providerThreadId: "thread-1",
      },
    } as never);
    expect(result).toMatchObject({
      providerInstanceId: "provider-1",
      providerSession: {
        providerInstanceId: "provider-1",
        providerThreadId: "thread-1",
      },
    });
  });

  test("checkpoint metadata is reduced into the snapshot", () => {
    const result = reduceRun(baseSnapshot({ status: "running" }), {
      type: "checkpoint.captured",
      turnId: "turn-1",
      occurredAt: 2,
      payload: {
        checkpointId: "checkpoint-1",
        commit: "abc123",
        ref: "refs/relay/checkpoint-1",
      },
    } as never);
    expect(result?.checkpoint).toMatchObject({
      checkpointId: "checkpoint-1",
      turnId: "turn-1",
      commit: "abc123",
    });
  });
});
