import type { MachinePlatform } from "@relay/shared";

import { runCommand } from "./tools";

export interface CommandGateway {
  appendOutput(input: { output: string; threadId: string }): Promise<unknown>;
  claim(): Promise<{ command: string; commandId: string; projectPath: string; threadId: string } | null>;
  complete(input: { commandId: string; status: "complete" | "failed" }): Promise<unknown>;
}

export async function runQueuedCommand({ gateway, platform, resolveProjectRoot }: { gateway: CommandGateway; platform: MachinePlatform; resolveProjectRoot?: (input: { repoPath: string; threadId: string }) => Promise<string> }): Promise<boolean> {
  const queued = await gateway.claim();
  if (!queued) return false;
  const root = resolveProjectRoot ? await resolveProjectRoot({ repoPath: queued.projectPath, threadId: queued.threadId }) : queued.projectPath;
  const result = await runCommand({ command: queued.command, platform, root });
  await gateway.appendOutput({ output: `${result.stdout}${result.stderr}`, threadId: queued.threadId });
  await gateway.complete({ commandId: queued.commandId, status: result.exitCode === 0 ? "complete" : "failed" });
  return true;
}
