import { makeFunctionReference } from "convex/server";

// ---------------------------------------------------------------------------
// Convex command source — the daemon's inbound intent channel.
// Replaces the per-work-type pollers with a single reactive sync loop.
// ---------------------------------------------------------------------------

const submitCommandMutation = makeFunctionReference<
  "mutation",
  { commandId: string; correlationId: string; kind: string; payloadJson: string; threadId: string },
  string
>("commands/inbox:submitToInbox");

const claimCommandBatch = makeFunctionReference<
  "mutation",
  { deviceToken: string; leaseDurationMs: number; limit: number },
  Array<{ _id: string; commandId?: string; correlationId: string; kind: string; leaseGeneration?: number; payloadJson: string; runId?: string }>
>("commands/inbox:claimBatch");

const completeCommand = makeFunctionReference<
  "mutation",
  { commandId: string; deviceToken: string; leaseGeneration: number; status: "completed" | "rejected" },
  null
>("commands/inbox:completeInbox");

export type CommandGateway = {
  submitCommand(input: { commandId: string; correlationId: string; kind: string; payloadJson: string; threadId: string }): Promise<string>;
  claimBatch(input: { deviceToken: string; leaseDurationMs: number; limit: number }): Promise<
    Array<{ commandId: string; correlationId: string; externalCommandId: string; kind: string; leaseGeneration: number; payloadJson: string; runId?: string }>
  >;
  completeCommand(input: { commandId: string; deviceToken: string; leaseGeneration: number; status: "completed" | "rejected" }): Promise<void>;
};

export function createConvexCommandSource(opts: {
  deploymentUrl: string;
  deviceToken: string;
}): CommandGateway {
  return {
    submitCommand: async (input) => {
      const result = await fetchMutation(opts.deploymentUrl, submitCommandMutation, { ...input });
      return result as string;
    },
    claimBatch: async (input) => {
      const rows = (await fetchMutation(opts.deploymentUrl, claimCommandBatch, { deviceToken: opts.deviceToken, leaseDurationMs: input.leaseDurationMs, limit: input.limit })) as Array<Record<string, unknown>> | null;
      return (rows ?? []).map((row: Record<string, unknown>) => ({
        commandId: row._id as string,
        correlationId: row.correlationId as string,
        externalCommandId: (row.commandId as string) ?? (row._id as string),
        kind: row.kind as string,
        leaseGeneration: (row.leaseGeneration as number) ?? 0,
        payloadJson: row.payloadJson as string,
        runId: row.runId as string | undefined,
      }));
    },
    completeCommand: async (input) => {
      await fetchMutation(opts.deploymentUrl, completeCommand, { commandId: input.commandId, deviceToken: opts.deviceToken, leaseGeneration: input.leaseGeneration, status: input.status });
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
