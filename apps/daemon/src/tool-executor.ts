import type { MachinePlatform } from "@relay/shared";

import { editFile, readProjectFile, runCommand } from "./tools";

export type ToolCall =
  | { content: string; kind: "edit"; path: string }
  | { kind: "read"; path: string }
  | { command: string; kind: "bash" };

export async function executeToolCall({ call, onCompleted, platform, root }: {
  call: ToolCall;
  onCompleted(event: { summary: string; tool: "bash" | "edit" | "read" }): Promise<void>;
  platform: MachinePlatform;
  root: string;
}): Promise<{ output: string; succeeded: boolean }> {
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
