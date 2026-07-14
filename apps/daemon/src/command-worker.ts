import type { MachinePlatform } from "@relay/shared";

import { executeGovernedToolCall, type GovernanceGateway } from "./governed-tool-executor";
import type { Policy } from "./policy";

export interface CommandGateway {
  appendOutput(input: { output: string; threadId: string }): Promise<unknown>;
  claim(): Promise<{ command: string; commandId: string; projectPath: string; threadId: string } | null>;
  complete(input: { commandId: string; status: "complete" | "failed" }): Promise<unknown>;
}

export async function runQueuedCommand({ gateway, governance, platform, policy, resolveProjectRoot }: { gateway: CommandGateway; governance: GovernanceGateway; platform: MachinePlatform; policy: Policy; resolveProjectRoot?: (input: { repoPath: string; threadId: string }) => Promise<string> }): Promise<boolean> {
  const queued = await gateway.claim();
  if (!queued) return false;
  const root = resolveProjectRoot ? await resolveProjectRoot({ repoPath: queued.projectPath, threadId: queued.threadId }) : queued.projectPath;
  let emittedOutput = false;
  const result = await executeGovernedToolCall({
    call: { command: queued.command, kind: "bash" },
    governance,
    onCompleted: async () => undefined,
    onOutput: async (output) => {
      emittedOutput = true;
      await gateway.appendOutput({ output, threadId: queued.threadId });
    },
    platform,
    policy,
    root,
    threadId: queued.threadId,
  });
  if (!emittedOutput) await gateway.appendOutput({ output: result.output, threadId: queued.threadId });
  await gateway.complete({ commandId: queued.commandId, status: result.kind === "executed" && result.succeeded ? "complete" : "failed" });
  return true;
}
