import { makeFunctionReference } from "convex/server";

// ---------------------------------------------------------------------------
// Convex command source — the daemon's inbound intent channel.
// Replaces the per-work-type pollers with a single reactive sync loop.
// ---------------------------------------------------------------------------

const submitCommandMutation = makeFunctionReference<
  "mutation",
  {
    correlationId: string;
    kind: string;
    machineId: string;
    ownerId?: string;
    payloadJson: string;
    runId?: string;
  },
  string
>("commands/inbox:submitToInbox");

const claimCommandBatch = makeFunctionReference<
  "mutation",
  { deviceToken: string; leaseDurationMs: number; limit: number },
  Array<{
    _id: string;
    correlationId: string;
    kind: string;
    payloadJson: string;
    runId?: string;
  }>
>("commands/inbox:claimBatch");

const completeCommand = makeFunctionReference<
  "mutation",
  { commandId: string; deviceToken: string; status: "completed" | "rejected" },
  null
>("commands/inbox:completeInbox");

export type CommandGateway = {
  submitCommand(input: {
    correlationId: string;
    kind: string;
    machineId: string;
    payloadJson: string;
    runId?: string;
  }): Promise<string>;
  claimBatch(input: {
    deviceToken: string;
    leaseDurationMs: number;
    limit: number;
  }): Promise<
    Array<{
      commandId: string;
      correlationId: string;
      kind: string;
      payloadJson: string;
      runId?: string;
    }>
  >;
  completeCommand(input: {
    commandId: string;
    deviceToken: string;
    status: "completed" | "rejected";
  }): Promise<void>;
};

export function createConvexCommandSource(opts: {
  deploymentUrl: string;
  deviceToken: string;
}): CommandGateway {
  return {
    submitCommand: async (input) => {
      const result = await fetchMutation(opts.deploymentUrl, submitCommandMutation, {
        ...input,
      });
      return result as string;
    },
    claimBatch: async (input) => {
      const rows = (await fetchMutation(opts.deploymentUrl, claimCommandBatch, {
        deviceToken: opts.deviceToken,
        leaseDurationMs: input.leaseDurationMs,
        limit: input.limit,
      })) as Array<Record<string, unknown>> | null;
      return (rows ?? []).map((row: Record<string, unknown>) => ({
        commandId: row._id as string,
        correlationId: row.correlationId as string,
        kind: row.kind as string,
        payloadJson: row.payloadJson as string,
        runId: row.runId as string | undefined,
      }));
    },
    completeCommand: async (input) => {
      await fetchMutation(opts.deploymentUrl, completeCommand, {
        commandId: input.commandId,
        deviceToken: opts.deviceToken,
        status: input.status,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Internal fetch helper (mirrors relay-client.ts pattern)
// ---------------------------------------------------------------------------

async function fetchMutation(
  deploymentUrl: string,
  ref: unknown,
  args: Record<string, unknown>,
): Promise<unknown> {
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

  const json = (await res.json()) as { value?: unknown };
  return json.value;
}
