import type { Capability, MachinePlatform } from "@relay/shared";

import { editFile, readProjectFile, runCommand } from "./tools";

export type ToolCall =
  | { content: string; kind: "edit"; path: string }
  | { kind: "read"; limit?: number; offset?: number; path: string }
  | { command: string; kind: "bash"; timeout?: number }
  | { capabilities: Capability[]; kind: "task"; role: string; task: string }
  | { arguments: Record<string, unknown>; kind: "mcp"; name: string; risk?: "low" | "high" | "critical"; serverId: string }
  | { body?: string; directory?: string; kind: "skill"; name: string }
  | { items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>; kind: "todo" }
  | { kind: "web_search"; query: string }
  | { kind: "web_fetch"; prompt?: string; url: string };

export async function executeToolCall({ call, onCompleted, onMcp, onOutput, onTask, platform, root }: {
  call: ToolCall;
  onCompleted(event: { summary: string; tool: "bash" | "edit" | "mcp" | "read" | "skill" | "task" | "web_search" | "web_fetch" }): Promise<void>;
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
  if (call.kind === "skill") {
    // Skill loading is handled externally via the onSkill callback
    const body = call.body ?? "Skill not loaded.";
    await onCompleted({ summary: `Loaded skill ${call.name}`, tool: "skill" });
    return { output: body, succeeded: true };
  }
  if (call.kind === "todo") {
    // Todo list is handled via the onTodo callback from the gateway
    const itemCount = call.items.length;
    await onCompleted({ summary: `Updated todo list (${itemCount} items)`, tool: "skill" });
    return { output: `Todo list updated (${itemCount} items)`, succeeded: true };
  }
  if (call.kind === "web_search") {
    // Pass-through: the model provider (Anthropic/OpenAI) executes web search
    // natively on their servers. We record the request and return a delegation
    // marker. The actual search results are incorporated by the model during
    // the streaming reply phase.
    await onCompleted({ summary: `Web search: ${call.query}`, tool: "web_search" });
    return { output: JSON.stringify({ kind: "web_search_delegated", query: call.query, note: "Search executed by model provider. See response for results." }), succeeded: true };
  }
  if (call.kind === "web_fetch") {
    // Pass-through: same as web_search — the model provider fetches the URL
    // natively and incorporates results into the streaming reply.
    await onCompleted({ summary: `Web fetch: ${call.url}`, tool: "web_fetch" });
    return { output: JSON.stringify({ kind: "web_fetch_delegated", url: call.url, prompt: call.prompt, note: "Fetch executed by model provider. See response for results." }), succeeded: true };
  }
  if (call.kind === "edit") {
    await editFile({ content: call.content, path: call.path, root });
    await onCompleted({ summary: `Edited ${call.path}`, tool: "edit" });
    return { output: "File edited", succeeded: true };
  }
  if (call.kind === "read") {
    const content = await readProjectFile({ limit: (call as { limit?: number }).limit, offset: (call as { offset?: number }).offset, path: call.path, root });
    await onCompleted({ summary: `Read ${call.path}`, tool: "read" });
    return { output: content, succeeded: true };
  }
  const result = await runCommand({ command: call.command, onOutput, platform, root, timeout: (call as { timeout?: number }).timeout });
  await onCompleted({ summary: `Ran ${call.command}`, tool: "bash" });
  return { output: `${result.stdout}${result.stderr}`, succeeded: result.exitCode === 0 };
}
