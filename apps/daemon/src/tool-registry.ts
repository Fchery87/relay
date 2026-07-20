import type { ToolCall } from "./tool-executor";
import { getToolDescription } from "./tool-descriptions";
import { classifyToolCall } from "./policy";
export type ToolKind = ToolCall["kind"];
export type ToolContract = Readonly<{ name: ToolKind; version: 1; description: string; timeoutMs: number; maxOutputBytes: number; classifier: (call: ToolCall) => ReturnType<typeof classifyToolCall> }>;
const kinds: readonly ToolKind[] = ["bash", "edit", "str_replace", "read", "grep", "glob", "task", "mcp", "skill", "todo", "web_search", "web_fetch"];
export const TOOL_REGISTRY: ReadonlyMap<ToolKind, ToolContract> = new Map(kinds.map(name => [name, Object.freeze({ name, version: 1 as const, description: getToolDescription(name), timeoutMs: name === "bash" ? 600_000 : 120_000, maxOutputBytes: 50 * 1024, classifier: classifyToolCall })]));
export function toolContract(call: ToolCall): ToolContract { const contract = TOOL_REGISTRY.get(call.kind); if (!contract) throw new Error(`Unregistered tool: ${call.kind}`); return contract; }
