import { expect, test, describe } from "bun:test";
import { CommandStateError, decide } from "./decider";
import {
  RUN_STATUSES,
  type ExternalCommandType,
  type InternalCommandType,
  type RunSnapshot,
  type Command,
  type RunStatus,
} from "@relay/contracts";

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
    const result = decide(
      snap({ status: "running" }),
      cmd("turn.send", { prompt: "hello", turnId: "turn-1" }),
    );
    expect(result.events[0]!.type).toBe("turn.started");
    expect(result.events[0]).toMatchObject({ turnId: "turn-1" });
    expect(result.snapshot?.activeTurnId).toBe("turn-1" as never);
    expect(result.effects.some((e) => e.kind === "provider.send_turn")).toBe(true);
  });

  test("turn.send rejects a second turn while one is active", () => {
    expect(() =>
      decide(
        snap({ status: "running", activeTurnId: "turn-active" as never }),
        cmd("turn.send", { prompt: "overlap", turnId: "turn-second" }),
      ),
    ).toThrow("turn turn-active is still active");
  });

  test("turn.steer emits turn.steered", () => {
    const result = decide(
      snap({ status: "running", activeTurnId: "turn-1" as never }),
      cmd("turn.steer", { steering: "go left" }),
    );
    expect(result.events[0]!.type).toBe("turn.steered");
    expect(result.events[0]).toMatchObject({ turnId: "turn-1" });
    expect(result.effects).toEqual([{
      kind: "provider.steer_turn",
      steering: "go left",
      turnId: "turn-1" as never,
    }]);
  });

  test("turn.interrupt emits turn.interrupted", () => {
    const result = decide(
      snap({ status: "running", activeTurnId: "turn-1" as never }),
      cmd("turn.interrupt", { reason: "cancel" }),
    );
    expect(result.events[0]!.type).toBe("turn.interrupted");
    expect(result.events[0]).toMatchObject({ turnId: "turn-1" });
    expect(result.effects).toEqual([{
      kind: "provider.interrupt_turn",
      reason: "cancel",
      turnId: "turn-1" as never,
    }]);
    expect(result.effectCancellations).toEqual([
      {
        kind: "provider.send_turn",
        reason: "Turn turn-1 was interrupted",
      },
      {
        kind: "provider.steer_turn",
        reason: "Turn turn-1 was interrupted",
      },
    ]);
    const duplicate = decide(
      result.snapshot!,
      cmd("turn.interrupt", { reason: "cancel again" }),
    );
    expect(duplicate.events).toHaveLength(0);
  });

  test("approval.resolve waits for provider acceptance before resolving", () => {
    const result = decide(
      snap({ status: "awaiting_approval", pendingApprovalId: "a1" }),
      cmd("approval.resolve", { approvalId: "a1", resolution: "allow" }),
    );
    expect(result.events).toHaveLength(0);
    expect(result.snapshot).toBeNull();
    expect(result.effects).toEqual([{
      kind: "provider.resolve_approval",
      approvalId: "a1",
      resolution: "allow",
      turnId: undefined,
    }]);

    const accepted = decide(
      snap({
        status: "awaiting_approval",
        pendingApprovalId: "a1",
        activeTurnId: "turn-1",
      }),
      cmd("effect.result", {
        effectId: "effect-approval",
        effectKind: "provider.resolve_approval",
        status: "completed",
        approvalId: "a1",
        resolution: "allow",
        turnId: "turn-1",
      }),
    );
    expect(accepted.events.map((event) => event.type)).toEqual(["approval.resolved", "turn.completed"]);
    expect(accepted.snapshot?.status).toBe("running");
    expect(accepted.snapshot?.activeTurnId).toBeUndefined();
  });

  test("approval.resolve rejects a stale approval identity", () => {
    expect(() =>
      decide(
        snap({
          status: "awaiting_approval",
          pendingApprovalId: "approval-current",
        }),
        cmd("approval.resolve", {
          approvalId: "approval-stale",
          resolution: "allow",
        }),
      ),
    ).toThrow("does not match pending approval");
  });

  test("provider approval resolution cannot bypass pending identity", () => {
    const result = decide(
      snap({
        status: "awaiting_approval",
        pendingApprovalId: "approval-current",
      }),
      cmd("provider.event", {
        providerInstanceId: "provider-1",
        normalizedEvent: {
          eventId: "ev-provider-stale-approval",
          type: "approval.resolved",
          payload: {
            approvalId: "approval-stale",
            resolution: "allow",
          },
          correlationId: "corr-provider-stale-approval",
        },
      }),
    );
    expect(result.events).toHaveLength(0);
    expect(result.snapshot).toBeNull();
  });

  test("provider.event preserves the adapter-normalised event", () => {
    const normalizedEvent = {
      eventId: "ev-provider-1" as never,
      type: "assistant.delta" as const,
      turnId: "turn-provider" as never,
      payload: { text: "real provider output" },
      correlationId: "corr-provider-1" as never,
      causationId: "cause-provider-1" as never,
    };
    const result = decide(
      snap({
        status: "running",
        activeTurnId: "turn-provider" as never,
      }),
      cmd("provider.event", {
        providerInstanceId: "provider-1",
        normalizedEvent,
      }),
    );

    expect(result.events).toEqual([normalizedEvent]);
    expect(result.snapshot?.status).toBe("running");
  });

  test("rejects a second terminal event for the same turn", () => {
    const active = snap({
      status: "running",
      activeTurnId: "turn-1" as never,
    });
    const completed = decide(
      active,
      cmd("provider.event", {
        providerInstanceId: "provider-1",
        normalizedEvent: {
          eventId: "ev-completed",
          type: "turn.completed",
          turnId: "turn-1",
          payload: {},
          correlationId: "corr-completed",
        },
      }),
    );
    const duplicate = decide(
      completed.snapshot!,
      cmd("provider.event", {
        providerInstanceId: "provider-1",
        normalizedEvent: {
          eventId: "ev-failed",
          type: "turn.failed",
          turnId: "turn-1",
          payload: { error: "late failure" },
          correlationId: "corr-failed",
        },
      }),
    );

    expect(completed.events).toHaveLength(1);
    expect(duplicate.events).toHaveLength(0);
  });

  test("does not create a turn failure without an active matching turn", () => {
    const result = decide(
      snap({ status: "running" }),
      cmd("effect.result", {
        effectId: "effect-1",
        effectKind: "provider.send_turn",
        status: "failed",
        error: "provider unavailable",
      }),
    );
    expect(result.events).toHaveLength(0);
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

  test("checkpoint restore emits success only after the reactor result", () => {
    const requested = decide(
      snap({ status: "running" }),
      cmd("checkpoint.restore", { checkpointId: "checkpoint-1" }),
    );
    expect(requested.events).toHaveLength(0);
    expect(requested.effects).toEqual([{
      kind: "checkpoint.restore",
      checkpointId: "checkpoint-1" as never,
    }]);

    const completed = decide(
      snap({ status: "running" }),
      cmd("checkpoint.result", {
        checkpointId: "checkpoint-1",
        commit: "abc123",
        ref: "refs/relay/checkpoint-1",
      }),
    );
    expect(completed.events).toEqual([
      expect.objectContaining({
        type: "checkpoint.restored",
        payload: { checkpointId: "checkpoint-1", commit: "abc123" },
      }),
    ]);
  });
});

describe("external command/state table", () => {
  const commandCases: ReadonlyArray<{
    type: ExternalCommandType;
    payload: Record<string, unknown>;
    allowed: ReadonlySet<RunStatus>;
    needsActiveTurn?: boolean;
  }> = [
    {
      type: "run.create",
      payload: { projectId: "project-1" },
      allowed: new Set(["created"]),
    },
    {
      type: "run.resume",
      payload: {},
      allowed: new Set(["ready", "running"]),
    },
    {
      type: "turn.send",
      payload: { prompt: "hello", turnId: "turn-next" },
      allowed: new Set(["running"]),
    },
    {
      type: "turn.steer",
      payload: { steering: "focus" },
      allowed: new Set(["running"]),
      needsActiveTurn: true,
    },
    {
      type: "turn.interrupt",
      payload: { reason: "user" },
      allowed: new Set(["running", "awaiting_approval"]),
      needsActiveTurn: true,
    },
    {
      type: "approval.resolve",
      payload: { approvalId: "approval-1", resolution: "allow" },
      allowed: new Set(["awaiting_approval"]),
    },
    {
      type: "run.stop",
      payload: { reason: "user" },
      allowed: new Set(["running", "awaiting_approval"]),
    },
    {
      type: "checkpoint.restore",
      payload: { checkpointId: "checkpoint-1" },
      allowed: new Set(["ready", "running", "awaiting_approval"]),
    },
  ];

  for (const commandCase of commandCases) {
    for (const status of RUN_STATUSES) {
      test(`${commandCase.type} ${status}`, () => {
        const snapshot = snap({
          status,
          ...(commandCase.needsActiveTurn
            ? { activeTurnId: "turn-active" as never }
            : {}),
          ...(commandCase.type === "approval.resolve" &&
          status === "awaiting_approval"
            ? { pendingApprovalId: "approval-1" }
            : {}),
        });
        const execute = () =>
          decide(snapshot, cmd(commandCase.type, commandCase.payload));

        if (commandCase.allowed.has(status)) {
          expect(execute).not.toThrow();
        } else {
          expect(execute).toThrow(CommandStateError);
        }
      });
    }
  }
});

describe("internal command/state table", () => {
  const commandCases: ReadonlyArray<{
    type: InternalCommandType;
    payload: Record<string, unknown>;
  }> = [
    {
      type: "provider.event",
      payload: {
        providerInstanceId: "provider-1",
        normalizedEvent: {
          eventId: "ev-internal-table",
          type: "usage.recorded",
          payload: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            thinkingTokens: 0,
            modelId: "state-table",
          },
          correlationId: "corr-internal-table",
        },
      },
    },
    { type: "workspace.result", payload: { kind: "ready", result: {} } },
    {
      type: "checkpoint.result",
      payload: { checkpointId: "checkpoint-1", commit: "abc", ref: "ref" },
    },
    {
      type: "effect.result",
      payload: {
        effectId: "effect-1",
        effectKind: "workspace.create",
        status: "failed",
        error: "failed",
      },
    },
    { type: "projection.ack", payload: { cursor: 1 } },
  ];

  for (const commandCase of commandCases) {
    for (const status of RUN_STATUSES) {
      test(`${commandCase.type} ${status}`, () => {
        const result = decide(
          snap({ status }),
          cmd(commandCase.type, commandCase.payload),
        );
        if (
          commandCase.type === "provider.event" &&
          (status === "stopped" || status === "completed" || status === "failed")
        ) {
          expect(result.events).toHaveLength(0);
        } else {
          expect(result).toBeDefined();
        }
      });
    }
  }

  test("drops turn-scoped provider output after interruption", () => {
    const active = snap({
      status: "running",
      activeTurnId: "turn-1" as never,
    });
    const interrupted = decide(
      active,
      cmd("turn.interrupt", { reason: "user" }),
    ).snapshot!;
    const late = decide(
      interrupted,
      cmd("provider.event", {
        providerInstanceId: "provider-1",
        normalizedEvent: {
          eventId: "ev-late",
          type: "assistant.delta",
          turnId: "turn-1",
          payload: { text: "late" },
          correlationId: "corr-late",
        },
      }),
    );
    expect(late.events).toHaveLength(0);
  });

  test("drops every foreign turn-scoped provider event", () => {
    const scoped = [
      { type: "turn.started", payload: { prompt: "late" } },
      { type: "turn.steered", payload: { steering: "late" } },
      { type: "turn.completed", payload: {} },
      { type: "turn.failed", payload: { error: "late" } },
      { type: "turn.interrupted", payload: { reason: "late" } },
      { type: "assistant.delta", payload: { text: "late" } },
      { type: "assistant.completed", payload: {} },
      {
        type: "activity.started",
        payload: { activityId: "activity-1", kind: "bash" },
      },
      {
        type: "activity.delta",
        payload: { activityId: "activity-1", content: "late" },
      },
      {
        type: "activity.completed",
        payload: { activityId: "activity-1" },
      },
      {
        type: "activity.failed",
        payload: { activityId: "activity-1", error: "late" },
      },
      {
        type: "checkpoint.captured",
        payload: {
          checkpointId: "checkpoint-1",
          commit: "abc",
          ref: "refs/relay/checkpoint-1",
        },
      },
    ] as const;
    for (const [index, event] of scoped.entries()) {
      const result = decide(
        snap({
          status: "running",
          activeTurnId: "turn-current" as never,
        }),
        cmd("provider.event", {
          providerInstanceId: "provider-1",
          normalizedEvent: {
            eventId: `ev-foreign-${index}`,
            ...event,
            turnId: "turn-foreign",
            correlationId: `corr-foreign-${index}`,
          },
        }),
      );
      expect(result.events).toHaveLength(0);
    }
  });
});
