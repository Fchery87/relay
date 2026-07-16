import type { CanonicalEvent } from "@relay/contracts";
import type {
  AssistantTextItem,
  CanonicalHistoryItem,
  HistoryProvenance,
  HistorySnapshot,
} from "@relay/contracts";

// ---------------------------------------------------------------------------
// History projection — rebuilds canonical history from ordered events.
// The same input events always produce the same snapshot (deterministic).
// ---------------------------------------------------------------------------

/**
 * Build a full history snapshot from an ordered event stream.
 */
export function buildHistory(
  runId: string,
  events: ReadonlyArray<CanonicalEvent>,
): HistorySnapshot {
  let snapshot: HistorySnapshot = {
    runId: runId as never,
    items: [],
    throughSequence: 0,
    createdAt: Date.now(),
  };

  for (const ev of events) {
    snapshot = applyEvent(snapshot, ev);
  }

  return snapshot;
}

/**
 * Resume building history: apply new events to an existing snapshot.
 */
export function resumeHistory(
  snapshot: HistorySnapshot,
  events: ReadonlyArray<CanonicalEvent>,
): HistorySnapshot {
  let current = snapshot;
  for (const ev of events) {
    if (ev.sequence <= current.throughSequence) continue;
    current = applyEvent(current, ev);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Per-event handling
// ---------------------------------------------------------------------------

function applyEvent(
  snapshot: HistorySnapshot,
  event: CanonicalEvent,
): HistorySnapshot {
  const items = [...snapshot.items];
  const prov = provenance(event);

  switch (event.type) {
    case "turn.started": {
      items.push({
        kind: "user_message",
        id: `user-${event.eventId}`,
        content: event.payload.prompt,
        turnId: (event.turnId ?? event.eventId) as never,
        createdAt: event.occurredAt,
        provenance: prov,
      });
      break;
    }

    case "assistant.delta":
    case "assistant.completed": {
      const last = lastItem(items);
      if (last?.kind === "assistant_text" && event.type === "assistant.delta") {
        // Append to existing text block
        items[items.length - 1] = {
          ...last,
          text: last.text + (event.payload.text ?? ""),
          provenance: mergeProvenance(last.provenance, prov),
        } as AssistantTextItem;
      } else if (event.type === "assistant.delta") {
        items.push({
          kind: "assistant_text",
          id: `asst-${event.eventId}`,
          text: event.payload.text ?? "",
          turnId: (event.turnId ?? event.eventId) as never,
          createdAt: event.occurredAt,
          provenance: prov,
        });
      }
      break;
    }

    case "activity.started":
    case "activity.delta":
    case "activity.completed": {
      if (event.type === "activity.completed" && event.payload.summary) {
        items.push({
          kind: "activity_summary",
          id: `activity-${event.eventId}`,
          activityId: event.payload.activityId as never,
          toolName: (event.payload as Record<string, unknown>).toolName as string ?? "unknown",
          summary: event.payload.summary,
          turnId: (event.turnId ?? event.eventId) as never,
          createdAt: event.occurredAt,
          provenance: prov,
        });
      }
      break;
    }

    case "approval.requested":
    case "approval.resolved": {
      if (event.type === "approval.resolved") {
        items.push({
          kind: "approval",
          id: `approval-${event.eventId}`,
          approvalId: event.payload.approvalId as never,
          capability: (event.payload as Record<string, unknown>).capability as string ?? "unknown",
          risk: (event.payload as Record<string, unknown>).risk as string ?? "unknown",
          resolution: event.payload.resolution,
          turnId: (event.turnId ?? event.eventId) as never,
          createdAt: event.occurredAt,
          provenance: prov,
        });
      }
      break;
    }

    case "activity.failed": {
      items.push({
        kind: "activity_summary",
        id: `activity-${event.eventId}`,
        activityId: event.payload.activityId as never,
        toolName: "unknown",
        summary: `Failed: ${event.payload.error}`,
        turnId: (event.turnId ?? event.eventId) as never,
        createdAt: event.occurredAt,
        provenance: prov,
      });
      break;
    }

    case "checkpoint.captured": {
      items.push({
        kind: "checkpoint",
        id: `checkpoint-${event.eventId}`,
        checkpointId: event.payload.checkpointId as never,
        commit: event.payload.commit,
        ref: event.payload.ref,
        turnId: (event.turnId ?? event.eventId) as never,
        createdAt: event.occurredAt,
        provenance: prov,
      });
      break;
    }

    case "checkpoint.restored":
    case "run.created":
    case "run.started":
    case "run.stopping":
    case "run.stopped":
    case "run.failed":
    case "provider.session.started":
    case "provider.session.resumed":
    case "provider.session.stopped":
    case "turn.steered":
    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted":
    case "usage.recorded":
    case "projection.published":
      // These events don't produce canonical history items.
      // Usage, steering, session events are observable but not in the visible timeline.
      break;

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      break;
    }
  }

  const throughSequence = Math.max(snapshot.throughSequence, event.sequence);
  return { ...snapshot, items, throughSequence, createdAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function provenance(event: CanonicalEvent): HistoryProvenance {
  return {
    eventSequences: [event.sequence],
    correlationId: event.correlationId as string,
  };
}

function mergeProvenance(
  a: HistoryProvenance,
  b: HistoryProvenance,
): HistoryProvenance {
  return {
    eventSequences: [...a.eventSequences, ...b.eventSequences],
    correlationId: a.correlationId,
  };
}

function lastItem(
  items: ReadonlyArray<CanonicalHistoryItem>,
): CanonicalHistoryItem | undefined {
  return items[items.length - 1];
}
