import type { Capability, MachinePlatform } from "@relay/shared";

import { editFile, readProjectFile, runCommand } from "./tools";

export type ToolCall =
  | { content: string; kind: "edit"; path: string }
  | { kind: "read"; path: string }
  | { command: string; kind: "bash" }
  | { capabilities: Capability[]; kind: "task"; role: string; task: string }
  | { arguments: Record<string, unknown>; kind: "mcp"; name: string; risk?: "low" | "high" | "critical"; serverId: string };

export async function executeToolCall({ call, onCompleted, onMcp, onOutput, onTask, platform, root }: {
  call: ToolCall;
  onCompleted(event: { summary: string; tool: "bash" | "edit" | "mcp" | "read" | "task" }): Promise<void>;
  onMcp?: (call: Extract<ToolCall, { kind: "mcp" }>) => Promise<unknown>;
  onOutput?: (output: string) => Promise<void>;
  onTask?: (call: Extract<ToolCall, { kind: "task" }>) => Promise<string>;
  platform: MachinePlatform;
  root: string;
}): Promise<{ output: string; succeeded: boolean }> {
  if (call.kind === "mcp") {
    if (!onMcp) throw new Error("MCP execution is not configured");
    const output = await onMcp(call);
    await onCompleted({ summary: `Called ${call.serverId}/${call.name}`, tool: "mcp" });
    return { output: JSON.stringify(output), succeeded: true };
  }
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
  const result = await runCommand({ command: call.command, onOutput, platform, root });
  await onCompleted({ summary: `Ran ${call.command}`, tool: "bash" });
  return { output: `${result.stdout}${result.stderr}`, succeeded: result.exitCode === 0 };
}
