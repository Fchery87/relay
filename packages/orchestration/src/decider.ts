import type { RunSnapshot } from "@relay/contracts";
import type { Command, ExternalCommand, InternalCommand } from "@relay/contracts";
import type {
  CanonicalEvent,
  CanonicalEventDraft,
  CanonicalEventType,
} from "@relay/contracts";
import { reduceRun, applySnapshot } from "@relay/contracts";

// ---------------------------------------------------------------------------
// Effect intents — returned by the decider, dispatched by reactors.
// ---------------------------------------------------------------------------

export type EffectIntent =
  | { readonly kind: "provider.start_session"; readonly providerInstanceId: string }
  | { readonly kind: "provider.send_turn"; readonly prompt: string }
  | { readonly kind: "provider.stop_session" }
  | { readonly kind: "workspace.create"; readonly repoPath: string }
  | { readonly kind: "checkpoint.capture"; readonly turnId: string }
  | { readonly kind: "projection.publish" };

// ---------------------------------------------------------------------------
// Decider result
// ---------------------------------------------------------------------------

export type DeciderResult = {
  readonly events: Array<CanonicalEventDraft>;
  readonly effects: ReadonlyArray<EffectIntent>;
  readonly snapshot: RunSnapshot | null;
};

// ---------------------------------------------------------------------------
// Pure decider — the ONLY function that translates commands into events/effects.
// Performs no I/O. Exhaustive switch enforced by TypeScript.
// ---------------------------------------------------------------------------

export function decide(
  snapshot: RunSnapshot,
  command: Command,
): DeciderResult {
  const events: DeciderResult["events"] = [];
  const effects: EffectIntent[] = [];
  const corrId = `corr-${command.commandId}`;
  const causationId = command.commandId as string;

  let current = snapshot;

  const appendEvent = <TType extends CanonicalEventType>(
    type: TType,
    payload: Extract<CanonicalEvent, { type: TType }>["payload"],
  ) => {
    const event = {
      eventId: `ev-${events.length + 1}-${command.commandId}` as never,
      type,
      payload,
      correlationId: corrId as never,
      causationId: causationId as never,
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
      appendEvent("turn.started", { prompt: command.payload.prompt });
      // Emit a provider effect so the engine knows to route the turn
      effects.push({ kind: "provider.send_turn", prompt: command.payload.prompt });
      const updated = reduceAndApply(current, events, command.issuedAt);
      return { events, effects, snapshot: updated };
    }

    case "turn.steer": {
      appendEvent("turn.steered", { steering: command.payload.steering });
      const updated = reduceAndApply(current, events, command.issuedAt);
      return { events, effects, snapshot: updated };
    }

    case "turn.interrupt": {
      appendEvent("turn.interrupted", { reason: command.payload.reason ?? "user" });
      const updated = reduceAndApply(current, events, command.issuedAt);
      return { events, effects, snapshot: updated };
    }

    // --- approval ---
    case "approval.resolve": {
      appendEvent("approval.resolved", {
        approvalId: command.payload.approvalId as never,
        resolution: command.payload.resolution,
      });
      const updated = reduceAndApply(current, events, command.issuedAt);
      return { events, effects, snapshot: updated };
    }

    // --- checkpoint ---
    case "checkpoint.restore": {
      appendEvent("checkpoint.restored", {
        checkpointId: command.payload.checkpointId as never,
        commit: "",
      });
      const updated = reduceAndApply(current, events, command.issuedAt);
      return { events, effects, snapshot: updated };
    }

    // --- internal commands from reactors ---
    case "provider.event": {
      // The provider adapter already normalised this event. Routing it through
      // an internal command keeps the decider as the sole transition owner.
      events.push(command.payload.normalizedEvent);
      const updated = reduceAndApply(current, events, command.issuedAt);
      return { events, effects, snapshot: updated };
    }

    case "workspace.result":
    case "checkpoint.result":
    case "projection.ack": {
      // Internal commands carry reactor results — no new events by default.
      return { events: [], effects: [], snapshot: null };
    }

    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return { events: [], effects: [], snapshot: null };
    }
  }
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
    const update = reduceRun(current, event);
    current = applySnapshot(current, {
      ...(update ?? {}),
      sequence: event.sequence,
      streamVersion: event.streamVersion,
      updatedAt: event.occurredAt,
    });
  }
  return current;
}
