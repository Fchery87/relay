import { expect, test, describe } from "bun:test";
import {
  reduceRun,
  replayRun,
  RunTransitionError,
  type RunSnapshot,
} from "./state";

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
      occurredAt: 2,
      payload: { mode: "plan", projectId: "project-1", title: "Plan the migration" },
    } as never);
    expect(result?.status).toBe("ready");
    expect(result?.projectId).toBe("project-1" as never);
    expect(result?.mode).toBe("plan");
    expect(result?.title).toBe("Plan the migration");
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
      payload: { approvalId: "approval-1" },
    } as never);
    expect(result?.status).toBe("awaiting_approval");
    expect(result?.pendingApprovalId).toBe("approval-1");
  });

  test("awaiting_approval → running on resolved", () => {
    const result = reduceRun(
      baseSnapshot({
        status: "awaiting_approval",
        pendingApprovalId: "approval-1",
      }),
      {
        type: "approval.resolved",
        payload: { approvalId: "approval-1", resolution: "allow" },
      } as never,
    );
    expect(result?.status).toBe("running");
    expect(result?.pendingApprovalId).toBeUndefined();
  });

  test("resolved when already running is no-op", () => {
    expect(reduceRun(baseSnapshot({ status: "running" }), { type: "approval.resolved" } as never)).toBeNull();
  });

  test("terminal turn clears a pending approval and returns to running", () => {
    const result = reduceRun(
      baseSnapshot({
        status: "awaiting_approval",
        activeTurnId: "turn-1" as never,
        pendingApprovalId: "approval-1",
      }),
      {
        type: "turn.interrupted",
        turnId: "turn-1",
        payload: { reason: "user" },
      } as never,
    );
    expect(result).toMatchObject({ status: "running" });
    expect(result?.activeTurnId).toBeUndefined();
    expect(result?.pendingApprovalId).toBeUndefined();
  });
});

// --- events that don't change status ---

describe("non-status events", () => {
  const noStatusChange: Array<{ payload?: unknown; type: string }> = [
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
    { type: "checkpoint.compared" },
    { type: "workspace.diff.updated" },
    { type: "git.action.updated" },
    { type: "review.comment.created" },
    { type: "review.comment.resolved" },
    { type: "projection.published" },
  ];

  for (const { type, payload } of noStatusChange) {
    test(`${type} does not change run status`, () => {
      const event = payload === undefined ? { type } : { type, payload };
      expect(reduceRun(baseSnapshot({ status: "running" }), event as never)).toBeNull();
      expect(reduceRun(baseSnapshot({ status: "ready" }), event as never)).toBeNull();
    });
  }
});

describe("run metadata", () => {
  test("run configuration updates durable provider and budget settings", () => {
    const result = reduceRun(baseSnapshot({ status: "ready" }), {
      occurredAt: 2,
      type: "run.configuration.updated",
      payload: { budgetUsd: 5, modelId: "model-1", permissionProfile: "read-only", thinkingLevel: "high" },
    } as never);
    expect(result).toMatchObject({ budgetUsd: 5, modelId: "model-1", permissionProfile: "read-only", thinkingLevel: "high", updatedAt: 2 });
  });

  test("plan updates persist phase, model pair, and revisioned artifact", () => {
    const result = reduceRun(baseSnapshot({ status: "running" }), {
      occurredAt: 2,
      type: "plan.updated",
      payload: {
        buildModelId: "builder",
        content: "1. Implement it",
        phase: "review",
        planModelId: "planner",
        revision: 1,
        status: "draft",
      },
    } as never);
    expect(result).toMatchObject({
      buildModelId: "builder",
      plan: { content: "1. Implement it", revision: 1, status: "draft" },
      planModelId: "planner",
      planPhase: "review",
      updatedAt: 2,
    });
  });

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

describe("deterministic replay", () => {
  test("rebuilds the same reducer-owned snapshot from an ordered event stream", () => {
    const initial = baseSnapshot({ createdAt: 1, updatedAt: 1 });
    const events = [
      {
        eventId: "ev-1",
        sequence: 1,
        streamVersion: 1,
        type: "run.created",
        runId: "run-1",
        correlationId: "corr-1",
        occurredAt: 2,
        payload: {
          environmentId: "local",
          projectId: "project-1",
          providerInstanceId: "provider-1",
        },
      },
      {
        eventId: "ev-2",
        sequence: 2,
        streamVersion: 2,
        type: "run.started",
        runId: "run-1",
        correlationId: "corr-1",
        occurredAt: 3,
        payload: {},
      },
      {
        eventId: "ev-3",
        sequence: 3,
        streamVersion: 3,
        type: "turn.started",
        runId: "run-1",
        turnId: "turn-1",
        correlationId: "corr-1",
        occurredAt: 4,
        payload: { prompt: "hello" },
      },
      {
        eventId: "ev-4",
        sequence: 4,
        streamVersion: 4,
        type: "turn.completed",
        runId: "run-1",
        turnId: "turn-1",
        correlationId: "corr-1",
        occurredAt: 5,
        payload: {},
      },
    ] as never;

    expect(replayRun(initial, events)).toMatchObject({
      status: "running",
      projectId: "project-1",
      providerInstanceId: "provider-1",
      sequence: 4,
      streamVersion: 4,
      updatedAt: 5,
    });
  });

  test("rejects an event gap instead of producing a plausible snapshot", () => {
    expect(() =>
      replayRun(baseSnapshot(), [{
        eventId: "ev-gap",
        sequence: 2,
        streamVersion: 2,
        type: "run.created",
        runId: "run-1",
        correlationId: "corr-1",
        occurredAt: 2,
        payload: { environmentId: "local", projectId: "project-1" },
      }] as never),
    ).toThrow("expected sequence 1");
  });
});
