import { makeFunctionReference } from "convex/server";

// ---------------------------------------------------------------------------
// Convex projection sink — publishes local outbox rows to cloud projections.
// ---------------------------------------------------------------------------

const appendEventsMutation = makeFunctionReference<
  "mutation",
  {
    events: Array<{
      eventId: string;
      occurredAt: number;
      payloadJson: string;
      runId: string;
      sequence: number;
      type: string;
    }>;
    machineId: string;
  },
  null
>("projections/publish:appendEvents");

const upsertSnapshotMutation = makeFunctionReference<
  "mutation",
  { runId: string; sequence: number; snapshotJson: string },
  null
>("projections/publish:upsertSnapshot");

const advanceCursorMutation = makeFunctionReference<
  "mutation",
  { direction: "inbound" | "outbound"; machineId: string; sequence: number },
  null
>("projections/publish:advanceCursor");

export type ProjectionSink = {
  appendEvents(input: {
    events: Array<{
      eventId: string;
      occurredAt: number;
      payloadJson: string;
      runId: string;
      sequence: number;
      type: string;
    }>;
    machineId: string;
  }): Promise<void>;
  upsertSnapshot(input: {
    runId: string;
    sequence: number;
    snapshotJson: string;
  }): Promise<void>;
  advanceCursor(input: {
    direction: "inbound" | "outbound";
    machineId: string;
    sequence: number;
  }): Promise<void>;
};

export function createConvexProjectionSink(opts: {
  deploymentUrl: string;
}): ProjectionSink {
  return {
    appendEvents: async (input) => {
      await fetchMutation(opts.deploymentUrl, appendEventsMutation, input as unknown as Record<string, unknown>);
    },
    upsertSnapshot: async (input) => {
      await fetchMutation(opts.deploymentUrl, upsertSnapshotMutation, input as unknown as Record<string, unknown>);
    },
    advanceCursor: async (input) => {
      await fetchMutation(opts.deploymentUrl, advanceCursorMutation, input as unknown as Record<string, unknown>);
    },
  };
}

async function fetchMutation(
  deploymentUrl: string,
  ref: unknown,
  args: Record<string, unknown>,
): Promise<void> {
  const url = `${deploymentUrl}/api/mutation`;
  const body = JSON.stringify({
    path: (ref as { _name: string })._name,
    args: [args],
    format: "json",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Convex mutation failed: ${res.status} ${await res.text()}`);
  }
}
