import {
  canonicalEventRequiresTurn,
  RUN_STATUSES,
  type ExternalCommandType,
  type InternalCommandType,
  type RunSnapshot,
  type RunStatus,
} from "@relay/contracts";
import type { Command } from "@relay/contracts";
import type {
  CanonicalEvent,
  CanonicalEventDraft,
  CanonicalEventType,
  EffectCancellation,
  EffectIntent,
} from "@relay/contracts";
import { replayRun } from "@relay/contracts";

// ---------------------------------------------------------------------------
// Effect intents — returned by the decider, dispatched by reactors.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Decider result
// ---------------------------------------------------------------------------

export type DeciderResult = {
  readonly events: Array<CanonicalEventDraft>;
  readonly effects: ReadonlyArray<EffectIntent>;
  readonly effectCancellations?: ReadonlyArray<EffectCancellation>;
  readonly snapshot: RunSnapshot | null;
};

const EXTERNAL_COMMAND_STATES: Readonly<
  Record<ExternalCommandType, ReadonlySet<RunStatus>>
> = {
  "run.create": new Set(["created"]),
  "run.resume": new Set(["ready", "running"]),
  "turn.send": new Set(["running"]),
  "turn.steer": new Set(["running"]),
  "turn.interrupt": new Set(["running", "awaiting_approval"]),
  "approval.resolve": new Set(["awaiting_approval"]),
  "run.stop": new Set(["running", "awaiting_approval"]),
  "checkpoint.restore": new Set(["ready", "running", "awaiting_approval"]),
};

const INTERNAL_COMMAND_STATES: Readonly<
  Record<InternalCommandType, ReadonlySet<RunStatus>>
> = {
  "provider.event": new Set([
    "created",
    "ready",
    "running",
    "awaiting_approval",
    "stopping",
  ]),
  "workspace.result": new Set(RUN_STATUSES),
  "checkpoint.result": new Set(RUN_STATUSES),
  "effect.result": new Set(RUN_STATUSES),
  "projection.ack": new Set(RUN_STATUSES),
};

export class CommandStateError extends Error {
  constructor(
    public readonly commandType: ExternalCommandType,
    public readonly status: RunStatus,
  ) {
    super(`Command ${commandType} is not allowed while run is ${status}`);
    this.name = "CommandStateError";
  }
}

// ---------------------------------------------------------------------------
// Pure decider — the ONLY function that translates commands into events/effects.
// Performs no I/O. Exhaustive switch enforced by TypeScript.
// ---------------------------------------------------------------------------

export function decide(
  snapshot: RunSnapshot,
  command: Command,
): DeciderResult {
  if (!acceptCommandState(snapshot.status, command)) {
    return { events: [], effects: [], snapshot: null };
  }
  const events: DeciderResult["events"] = [];
  const effects: EffectIntent[] = [];
  const corrId = `corr-${command.commandId}`;
  const causationId = command.commandId as string;

  let current = snapshot;

  const appendEvent = <TType extends CanonicalEventType>(
    type: TType,
    payload: Extract<CanonicalEvent, { type: TType }>["payload"],
    metadata?: Pick<
      Extract<CanonicalEventDraft, { type: TType }>,
      "turnId" | "providerInstanceId"
    >,
  ) => {
    const event = {
      eventId: `ev-${events.length + 1}-${command.commandId}` as never,
      type,
      payload,
      correlationId: corrId as never,
      causationId: causationId as never,
      ...metadata,
    } as unknown as Extract<CanonicalEventDraft, { type: TType }>;
    events.push(event);
  };

  switch (command.type) {
    // --- run lifecycle ---
    case "run.create": {
      appendEvent("run.created", {
        environmentId: "local" as never,
        projectId: command.payload.projectId as never,
        providerInstanceId: command.payload.providerInstanceId,
        permissionProfile: command.payload.permissionProfile,
      });
      const updated = reduceAndApply(current, events, command.issuedAt);
      return { events, effects, snapshot: updated };
    }

    case "run.resume": {
      appendEvent("run.started", {});
      const updated = reduceAndApply(current, events, command.issuedAt);
      return { events, effects, snapshot: updated };
    }

    case "run.stop": {
      appendEvent("run.stopping", {
        reason:
          command.payload.reason === "error" ||
          command.payload.reason === "shutdown"
            ? command.payload.reason
            : "user",
      });
      appendEvent("run.stopped", {});
      effects.push({ kind: "provider.stop_session" });
      const updated = reduceAndApply(current, events, command.issuedAt);
      return { events, effects, snapshot: updated };
    }

    // --- turn lifecycle ---
    case "turn.send": {
      if (snapshot.activeTurnId) {
        throw new Error(
          `Cannot start turn ${command.payload.turnId}; turn ${snapshot.activeTurnId} is still active`,
        );
      }
      appendEvent(
        "turn.started",
        { prompt: command.payload.prompt },
        { turnId: command.payload.turnId },
      );
      // Emit a provider effect so the engine knows to route the turn
      effects.push({
        kind: "provider.send_turn",
        prompt: command.payload.prompt,
        ...(command.payload.reviewComments ? { reviewComments: command.payload.reviewComments } : {}),
        ...(command.payload.reviewCommentIds ? { reviewCommentIds: command.payload.reviewCommentIds } : {}),
        turnId: command.payload.turnId,
      });
      const updated = reduceAndApply(current, events, command.issuedAt);
      return { events, effects, snapshot: updated };
    }

    case "turn.steer": {
      if (!snapshot.activeTurnId) {
        throw new Error("Cannot steer a run without an active turn");
      }
      appendEvent(
        "turn.steered",
        { steering: command.payload.steering },
        { turnId: snapshot.activeTurnId },
      );
      effects.push({
        kind: "provider.steer_turn",
        steering: command.payload.steering,
        turnId: snapshot.activeTurnId,
      });
      const updated = reduceAndApply(current, events, command.issuedAt);
      return { events, effects, snapshot: updated };
    }

    case "turn.interrupt": {
      if (!snapshot.activeTurnId) {
        return { events: [], effects: [], snapshot: null };
      }
      appendEvent(
        "turn.interrupted",
        { reason: command.payload.reason ?? "user" },
        { turnId: snapshot.activeTurnId },
      );
      effects.push({
        kind: "provider.interrupt_turn",
        reason: command.payload.reason ?? "user",
        turnId: snapshot.activeTurnId,
      });
      const updated = reduceAndApply(current, events, command.issuedAt);
      return {
        events,
        effects,
        effectCancellations: [
          {
            kind: "provider.send_turn",
            reason: `Turn ${snapshot.activeTurnId} was interrupted`,
          },
          {
            kind: "provider.steer_turn",
            reason: `Turn ${snapshot.activeTurnId} was interrupted`,
          },
          {
            kind: "provider.resolve_approval",
            reason: `Turn ${snapshot.activeTurnId} was interrupted`,
          },
        ],
        snapshot: updated,
      };
    }

    // --- approval ---
    case "approval.resolve": {
      if (snapshot.pendingApprovalId !== command.payload.approvalId) {
        throw new Error(
          `Approval ${command.payload.approvalId} does not match pending approval ${snapshot.pendingApprovalId ?? "none"}`,
        );
      }
      effects.push({
        kind: "provider.resolve_approval",
        approvalId: command.payload.approvalId,
        resolution: command.payload.resolution,
        turnId: snapshot.activeTurnId,
      });
      return { events, effects, snapshot: null };
    }

    // --- checkpoint ---
    case "checkpoint.restore": {
      effects.push({
        kind: "checkpoint.restore",
        checkpointId: command.payload.checkpointId as never,
      });
      return { events, effects, snapshot: null };
    }

    // --- internal commands from reactors ---
    case "provider.event": {
      // The provider adapter already normalised this event. Routing it through
      // an internal command keeps the decider as the sole transition owner.
      if (
        command.payload.normalizedEvent.type === "approval.resolved" &&
        command.payload.normalizedEvent.payload.approvalId !==
          snapshot.pendingApprovalId
      ) {
        return { events: [], effects: [], snapshot: null };
      }
      if (
        canonicalEventRequiresTurn(command.payload.normalizedEvent.type) &&
        command.payload.normalizedEvent.turnId !== snapshot.activeTurnId
      ) {
        return { events: [], effects: [], snapshot: null };
      }
      events.push(command.payload.normalizedEvent);
      const updated = reduceAndApply(current, events, command.issuedAt);
      const terminalTurnEvent =
        command.payload.normalizedEvent.type === "turn.completed" ||
        command.payload.normalizedEvent.type === "turn.failed" ||
        command.payload.normalizedEvent.type === "turn.interrupted";
      return {
        events,
        effects,
        ...(terminalTurnEvent
          ? {
              effectCancellations: [
                {
                  kind: "provider.send_turn" as const,
                  reason: "The provider turn reached a terminal state",
                },
                {
                  kind: "provider.steer_turn" as const,
                  reason: "The provider turn reached a terminal state",
                },
                {
                  kind: "provider.interrupt_turn" as const,
                  reason: "The provider turn reached a terminal state",
                },
              ],
            }
          : {}),
        snapshot: updated,
      };
    }

    case "workspace.result":
    case "projection.ack": {
      // Internal commands carry reactor results — no new events by default.
      return { events: [], effects: [], snapshot: null };
    }

    case "checkpoint.result": {
      appendEvent("checkpoint.restored", {
        checkpointId: command.payload.checkpointId as never,
        commit: command.payload.commit,
      });
      const updated = reduceAndApply(current, events, command.issuedAt);
      return { events, effects, snapshot: updated };
    }

    case "effect.result": {
      if (
        command.payload.status === "completed" &&
        command.payload.effectKind === "provider.resolve_approval" &&
        command.payload.approvalId !== undefined &&
        command.payload.resolution !== undefined &&
        command.payload.approvalId === snapshot.pendingApprovalId
      ) {
        appendEvent("approval.resolved", {
          approvalId: command.payload.approvalId as never,
          resolution: command.payload.resolution,
        });
        if (
          command.payload.turnId !== undefined &&
          command.payload.turnId === snapshot.activeTurnId
        ) {
          appendEvent(
            "turn.completed",
            {},
            { turnId: command.payload.turnId },
          );
        }
        const updated = reduceAndApply(current, events, command.issuedAt);
        return { events, effects, snapshot: updated };
      }
      if (
        command.payload.status === "failed" &&
        command.payload.effectKind === "provider.send_turn" &&
        command.payload.turnId !== undefined &&
        snapshot.activeTurnId !== undefined &&
        command.payload.turnId === snapshot.activeTurnId
      ) {
        appendEvent(
          "turn.failed",
          { error: command.payload.error },
          { turnId: command.payload.turnId },
        );
        const updated = reduceAndApply(current, events, command.issuedAt);
        return { events, effects, snapshot: updated };
      }
      return { events: [], effects: [], snapshot: null };
    }

    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return { events: [], effects: [], snapshot: null };
    }
  }
}

function acceptCommandState(
  status: RunStatus,
  command: Command,
): boolean {
  if (isExternalCommandType(command.type)) {
    if (EXTERNAL_COMMAND_STATES[command.type].has(status)) return true;
    throw new CommandStateError(command.type, status);
  }
  return INTERNAL_COMMAND_STATES[command.type].has(status);
}

function isExternalCommandType(
  type: Command["type"],
): type is ExternalCommandType {
  return Object.prototype.hasOwnProperty.call(EXTERNAL_COMMAND_STATES, type);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reduceAndApply(
  snapshot: RunSnapshot,
  events: DeciderResult["events"],
  occurredAt: number,
): RunSnapshot {
  let current = snapshot;
  for (const ev of events) {
    const event = {
      ...ev,
      sequence: current.sequence + 1,
      streamVersion: current.streamVersion + 1,
      runId: current.runId,
      occurredAt,
    } as CanonicalEvent;
    current = replayRun(current, [event]);
  }
  return current;
}
