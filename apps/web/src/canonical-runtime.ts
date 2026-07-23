import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { ClientRuntime, type CanonicalEventType, type ClientConfig, type ClientState, type EventEnvelope, type RunSnapshot } from "@relay/client-runtime";
import type { ProjectionEventDocument, ProjectionSnapshotDocument } from "./run-data";
import { getProjectionSnapshot, listProjectionEvents, ProjectionCursorManager } from "./run-data";

export type ProjectionRunState = {
  readonly error?: string;
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
    runId ? { afterSequence: snapshot?.sequence ?? 0, limit: 200, runId } : "skip",
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
    void runtime.connect(runId).then((state) => setResult({ state })).catch((error: unknown) => {
      setResult({ error: error instanceof Error ? error.message : String(error) });
    });
  }, [events, runId, snapshot]);

  return result;
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
