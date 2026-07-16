import type { RunSnapshot } from "@relay/contracts";
import type { Command, ExternalCommand, InternalCommand } from "@relay/contracts";
import type { CanonicalEvent } from "@relay/contracts";
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
  readonly events: Array<{
    readonly eventId: string;
    readonly type: CanonicalEvent["type"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly payload: Record<string, any>;
    readonly correlationId: string;
    readonly causationId?: string;
  }>;
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

  const appendEvent = (
    type: CanonicalEvent["type"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: Record<string, any> = {},
  ) => {
    events.push({
      eventId: `ev-${events.length + 1}-${command.commandId}`,
      type,
      payload,
      correlationId: corrId,
      causationId,
    });
  };

  switch (command.type) {
    // --- run lifecycle ---
    case "run.create": {
      appendEvent("run.created", {
        environmentId: "local",
        projectId: command.payload.projectId,
        providerInstanceId: command.payload.providerInstanceId,
      });
      // createRun sets initial snapshot before calling decide, so just validate.
      return { events, effects, snapshot: null };
    }

    case "run.resume": {
      appendEvent("run.started");
      const updated = reduceAndApply(current, events);
      return { events, effects, snapshot: updated };
    }

    case "run.stop": {
      appendEvent("run.stopping", { reason: command.payload.reason ?? "user" });
      appendEvent("run.stopped");
      effects.push({ kind: "provider.stop_session" });
      const updated = reduceAndApply(current, events);
      return { events, effects, snapshot: updated };
    }

    // --- turn lifecycle ---
    case "turn.send": {
      appendEvent("turn.started", { prompt: command.payload.prompt });
      // Emit a provider effect so the engine knows to route the turn
      effects.push({ kind: "provider.send_turn", prompt: command.payload.prompt });
      const updated = reduceAndApply(current, events);
      return { events, effects, snapshot: updated };
    }

    case "turn.steer": {
      appendEvent("turn.steered", { steering: command.payload.steering });
      const updated = reduceAndApply(current, events);
      return { events, effects, snapshot: updated };
    }

    case "turn.interrupt": {
      appendEvent("turn.interrupted", { reason: command.payload.reason ?? "user" });
      const updated = reduceAndApply(current, events);
      return { events, effects, snapshot: updated };
    }

    // --- approval ---
    case "approval.resolve": {
      appendEvent("approval.resolved", {
        approvalId: command.payload.approvalId,
        resolution: command.payload.resolution,
      });
      const updated = reduceAndApply(current, events);
      return { events, effects, snapshot: updated };
    }

    // --- checkpoint ---
    case "checkpoint.restore": {
      appendEvent("checkpoint.restored", {
        checkpointId: command.payload.checkpointId,
        commit: "",
      });
      const updated = reduceAndApply(current, events);
      return { events, effects, snapshot: updated };
    }

    // --- internal commands from reactors ---
    case "provider.event": {
      // Reactors report results as internal commands; the decider records them
      // but does not interpret provider-native semantics.
      appendEvent("activity.completed", { activityId: command.commandId });
      const updated = reduceAndApply(current, events);
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
): RunSnapshot {
  let current = snapshot;
  for (const ev of events) {
    const update = reduceRun(current, { type: ev.type } as CanonicalEvent);
    current = applySnapshot(current, update);
  }
  return current;
}
