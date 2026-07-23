import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { ClientRuntime, type CanonicalEventType, type ClientConfig, type ClientState, type EventEnvelope, type RunSnapshot } from "@relay/client-runtime";
import type { ProjectionEventDocument, ProjectionSnapshotDocument } from "./run-data";
import { getProjectionSnapshot, listProjectionEvents, ProjectionCursorManager } from "./run-data";
import type { ThreadMessage } from "./thread-messages";

export type ProjectionRunState = {
  readonly error?: string;
  readonly events?: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>;
  readonly state?: ClientState;
};

export function createCanonicalRuntime(config: ClientConfig): ClientRuntime { return new ClientRuntime(config); }
export type CanonicalClientState = ClientState;

/**
 * React bridge for the projection plane. Convex remains the transport, while
 * ClientRuntime owns ordering, reduction, cursor confirmation, and fail-closed
 * gap handling.
 */
export function useProjectionRun(runId: string | undefined): ProjectionRunState {
  const snapshot = useQuery(getProjectionSnapshot, runId ? { runId } : "skip");
  const events = useQuery(
    listProjectionEvents,
    runId ? { afterSequence: Math.max(0, (snapshot?.sequence ?? 0) - 200), limit: 200, runId } : "skip",
  );
  const [result, setResult] = useState<ProjectionRunState>({});

  useEffect(() => {
    if (!runId || !snapshot) {
      setResult({});
      return;
    }
    const config: ClientConfig = {
      fetchSnapshot: async () => decodeSnapshot(snapshot),
      fetchEvents: async () => (events ?? []).map(decodeEvent),
      submitCommand: async () => { throw new Error("Projection hook does not submit commands directly"); },
      cursorStore: {
        load: (cursorRunId) => new ProjectionCursorManager().load(cursorRunId)?.confirmedSequence,
        save: (cursorRunId, sequence) => new ProjectionCursorManager().save(cursorRunId, sequence),
      },
    };
    const runtime = createCanonicalRuntime(config);
    const decodedEvents = (events ?? []).map(decodeEvent);
    void runtime.connect(runId).then((state) => setResult({ events: decodedEvents, state })).catch((error: unknown) => {
      setResult({ error: error instanceof Error ? error.message : String(error) });
    });
  }, [events, runId, snapshot]);

  return result;
}

/** Convert the canonical event tail into the message shape used by the web surface. */
export function projectionEventsToMessages(events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  const assistantByTurn = new Map<string, ThreadMessage>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const turnId = event.turnId as string | undefined;
    if (event.type === "turn.started" && turnId) {
      const prompt = event.payload && typeof event.payload === "object" ? (event.payload as { prompt?: unknown }).prompt : undefined;
      if (typeof prompt === "string") messages.push({ _id: `user:${turnId}`, content: prompt, role: "user", status: "complete" });
    }
    if (event.type === "assistant.delta" && turnId) {
      const text = event.payload && typeof event.payload === "object" ? (event.payload as { text?: unknown }).text : undefined;
      if (typeof text !== "string") continue;
      const existing = assistantByTurn.get(turnId);
      if (existing) existing.content += text;
      else {
        const message: ThreadMessage = { _id: `assistant:${turnId}`, content: text, role: "assistant", status: "streaming" };
        assistantByTurn.set(turnId, message);
        messages.push(message);
      }
    }
    if ((event.type === "assistant.completed" || event.type === "turn.completed" || event.type === "turn.failed") && turnId) {
      const message = assistantByTurn.get(turnId);
      if (message) message.status = event.type === "turn.failed" ? "complete" : "complete";
    }
  }
  return messages;
}

function decodeSnapshot(document: ProjectionSnapshotDocument): RunSnapshot {
  const parsed = JSON.parse(document.snapshotJson) as RunSnapshot;
  return {
    ...parsed,
    projectId: parsed.projectId ?? document.projectId as never,
    runId: document.runId as never,
    sequence: document.sequence,
    streamVersion: parsed.streamVersion ?? document.sequence,
  };
}

function decodeEvent(document: ProjectionEventDocument): EventEnvelope<CanonicalEventType, unknown> {
  return {
    eventId: document.eventId as never,
    occurredAt: document.occurredAt,
    payload: JSON.parse(document.payloadJson) as unknown,
    runId: document.runId as never,
    sequence: document.sequence,
    streamVersion: document.streamVersion ?? document.sequence,
    type: document.type as CanonicalEventType,
    correlationId: `projection:${document.runId}` as never,
  };
}
