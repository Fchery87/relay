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
}): Promise<string> {
  if (call.kind === "edit") {
    await editFile({ content: call.content, path: call.path, root });
    await onCompleted({ summary: `Edited ${call.path}`, tool: "edit" });
    return "File edited";
  }
  if (call.kind === "read") {
    const content = await readProjectFile({ path: call.path, root });
    await onCompleted({ summary: `Read ${call.path}`, tool: "read" });
    return content;
  }
  const result = await runCommand({ command: call.command, platform, root });
  await onCompleted({ summary: `Ran ${call.command}`, tool: "bash" });
  return `${result.stdout}${result.stderr}`;
}
