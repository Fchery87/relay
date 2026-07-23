import { getFunctionName, makeFunctionReference } from "convex/server";

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
  Array<{ _id: string; commandId?: string; correlationId: string; kind: string; leaseGeneration?: number; payloadJson: string; projectPath?: string; runId?: string }>
>("commands/inbox:claimBatch");

const completeCommand = makeFunctionReference<
  "mutation",
  { commandId: string; deviceToken: string; leaseGeneration: number; status: "completed" | "rejected" },
  null
>("commands/inbox:completeInbox");

const renewLeaseMutation = makeFunctionReference<
  "mutation",
  { commandId: string; deviceToken: string; leaseDurationMs: number; leaseGeneration: number },
  null
>("commands/inbox:renewLease");

export type CommandGateway = {
  submitCommand(input: { commandId: string; correlationId: string; kind: string; payloadJson: string; threadId: string }): Promise<string>;
  claimBatch(input: { deviceToken: string; leaseDurationMs: number; limit: number }): Promise<
    Array<{ commandId: string; correlationId: string; externalCommandId: string; kind: string; leaseGeneration: number; payloadJson: string; projectPath?: string; runId?: string }>
  >;
  completeCommand(input: { commandId: string; deviceToken: string; leaseGeneration: number; status: "completed" | "rejected" }): Promise<void>;
  /**
   * Renew the exact lease generation held for a claimed command. Throws if
   * the lease was lost (expired and reclaimed, or held by another
   * machine/generation) — callers must fence work on renewal failure rather
   * than complete with a stale generation.
   */
  renewLease(input: { commandId: string; deviceToken: string; leaseDurationMs: number; leaseGeneration: number }): Promise<void>;
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
        projectPath: row.projectPath as string | undefined,
        runId: row.runId as string | undefined,
      }));
    },
    completeCommand: async (input) => {
      await fetchMutation(opts.deploymentUrl, completeCommand, { commandId: input.commandId, deviceToken: opts.deviceToken, leaseGeneration: input.leaseGeneration, status: input.status });
    },
    renewLease: async (input) => {
      await fetchMutation(opts.deploymentUrl, renewLeaseMutation, { commandId: input.commandId, deviceToken: opts.deviceToken, leaseDurationMs: input.leaseDurationMs, leaseGeneration: input.leaseGeneration });
    },
  };
}

// ---------------------------------------------------------------------------
// Internal fetch helper (mirrors relay-client.ts pattern)
// ---------------------------------------------------------------------------

async function fetchMutation(
  deploymentUrl: string,
  ref: Parameters<typeof getFunctionName>[0],
  args: Record<string, unknown>,
): Promise<unknown> {
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

  const responseText = await res.text();
  if (!res.ok) throw new Error(`Convex mutation failed: ${res.status} ${responseText}`);
  let json: { status?: "success" | "error"; value?: unknown; errorMessage?: string };
  try {
    json = JSON.parse(responseText) as { status?: "success" | "error"; value?: unknown; errorMessage?: string };
  } catch {
    throw new Error(`Convex mutation returned invalid JSON: ${responseText}`);
  }
  if (json.status === "error") throw new Error(`Convex mutation rejected: ${json.errorMessage ?? "unknown error"}`);
  return json.value;
}
