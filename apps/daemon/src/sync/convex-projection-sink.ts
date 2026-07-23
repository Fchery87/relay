import { getFunctionName, makeFunctionReference } from "convex/server";

// ---------------------------------------------------------------------------
// Convex projection sink — publishes local outbox rows to cloud projections.
// ---------------------------------------------------------------------------

const appendEventsMutation = makeFunctionReference<
  "mutation",
  { events: Array<{ eventId: string; occurredAt: number; payloadJson: string; projectId: string; runId: string; sequence: number; type: string }>; deviceToken: string },
  null
>("projections/publish:appendEvents");

const upsertSnapshotMutation = makeFunctionReference<
  "mutation",
  { projectId: string; runId: string; sequence: number; snapshotJson: string; deviceToken: string },
  null
>("projections/publish:upsertSnapshot");

const advanceCursorMutation = makeFunctionReference<
  "mutation",
  { direction: "inbound" | "outbound"; machineId: string; sequence: number; deviceToken: string },
  null
>("projections/publish:advanceCursor");

export type ProjectionSink = {
  appendEvents(input: { events: Array<{ eventId: string; occurredAt: number; payloadJson: string; projectId: string; runId: string; sequence: number; type: string }>; deviceToken: string }): Promise<void>;
  upsertSnapshot(input: { projectId: string; runId: string; sequence: number; snapshotJson: string; deviceToken: string }): Promise<void>;
  advanceCursor(input: { direction: "inbound" | "outbound"; machineId: string; sequence: number; deviceToken: string }): Promise<void>;
};

export function createConvexProjectionSink(opts: { deploymentUrl: string; deviceToken: string }): ProjectionSink {
  return {
    appendEvents: async (input) => {
      await fetchMutation(opts.deploymentUrl, appendEventsMutation, { ...input, deviceToken: opts.deviceToken } as unknown as Record<string, unknown>);
    },
    upsertSnapshot: async (input) => {
      await fetchMutation(opts.deploymentUrl, upsertSnapshotMutation, { ...input, deviceToken: opts.deviceToken } as unknown as Record<string, unknown>);
    },
    advanceCursor: async (input) => {
      await fetchMutation(opts.deploymentUrl, advanceCursorMutation, { ...input, deviceToken: opts.deviceToken } as unknown as Record<string, unknown>);
    },
  };
}

async function fetchMutation(
  deploymentUrl: string,
  ref: Parameters<typeof getFunctionName>[0],
  args: Record<string, unknown>,
): Promise<void> {
  const url = `${deploymentUrl}/api/mutation`;
  const body = JSON.stringify({
    path: getFunctionName(ref),
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
