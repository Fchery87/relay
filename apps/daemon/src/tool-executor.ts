import type { Capability, MachinePlatform } from "@relay/shared";

import { editFile, readProjectFile, runCommand } from "./tools";

export type ToolCall =
  | { content: string; kind: "edit"; path: string }
  | { kind: "read"; path: string }
  | { command: string; kind: "bash" }
  | { capabilities: Capability[]; kind: "task"; role: string; task: string };

export async function executeToolCall({ call, onCompleted, onTask, platform, root }: {
  call: ToolCall;
  onCompleted(event: { summary: string; tool: "bash" | "edit" | "read" | "task" }): Promise<void>;
  onTask?: (call: Extract<ToolCall, { kind: "task" }>) => Promise<string>;
  platform: MachinePlatform;
  root: string;
}): Promise<{ output: string; succeeded: boolean }> {
  if (call.kind === "task") {
    if (!onTask) throw new Error("Subagent execution is not configured");
    const output = await onTask(call);
    await onCompleted({ summary: `Delegated to ${call.role}`, tool: "task" });
    return { output, succeeded: true };
  }
  if (call.kind === "edit") {
    await editFile({ content: call.content, path: call.path, root });
    await onCompleted({ summary: `Edited ${call.path}`, tool: "edit" });
    return { output: "File edited", succeeded: true };
  }
  if (call.kind === "read") {
    const content = await readProjectFile({ path: call.path, root });
    await onCompleted({ summary: `Read ${call.path}`, tool: "read" });
    return { output: content, succeeded: true };
  }
  const result = await runCommand({ command: call.command, platform, root });
  await onCompleted({ summary: `Ran ${call.command}`, tool: "bash" });
  return { output: `${result.stdout}${result.stderr}`, succeeded: result.exitCode === 0 };
}
