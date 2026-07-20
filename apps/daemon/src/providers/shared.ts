import { z } from "zod";

import type { ToolCall } from "../tool-executor";

/** Serialize a ToolCall back to the argument object the model originally produced. */
export function toolCallToArgs(call: ToolCall): Record<string, unknown> {
  if (call.kind === "bash") return { command: call.command };
  if (call.kind === "read") return { path: call.path };
  if (call.kind === "edit") return { content: call.content, path: call.path };
  if (call.kind === "str_replace") return { newString: call.newString, oldString: call.oldString, path: call.path, ...(call.replaceAll === undefined ? {} : { replaceAll: call.replaceAll }) };
  if (call.kind === "grep") return { pattern: call.pattern, ...(call.path === undefined ? {} : { path: call.path }), ...(call.glob === undefined ? {} : { glob: call.glob }) };
  if (call.kind === "glob") return { pattern: call.pattern };
  if (call.kind === "todo") return { items: call.items };
  if (call.kind === "task") return { capabilities: call.capabilities, role: call.role, task: call.task };
  if (call.kind === "web_search") return { query: call.query };
  if (call.kind === "web_fetch") return { prompt: call.prompt ?? "", url: call.url };
  if (call.kind === "mcp") return call.arguments;
  if (call.kind === "skill") return { name: call.name };
  return {};
}

/** Shared schema for parsing tool calls across providers. */
export const toolCallSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), limit: z.number().optional(), offset: z.number().optional(), path: z.string() }),
  z.object({ content: z.string(), kind: z.literal("edit"), path: z.string() }),
  z.object({ kind: z.literal("str_replace"), newString: z.string(), oldString: z.string(), path: z.string(), replaceAll: z.boolean().optional() }),
  z.object({ glob: z.string().optional(), kind: z.literal("grep"), path: z.string().optional(), pattern: z.string() }),
  z.object({ kind: z.literal("glob"), pattern: z.string() }),
  z.object({ command: z.string(), kind: z.literal("bash"), timeout: z.number().optional() }),
  z.object({ capabilities: z.array(z.enum(["read", "edit", "exec", "task"])), kind: z.literal("task"), role: z.string(), task: z.string() }),
  z.object({ items: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })), kind: z.literal("todo") }),
  z.object({ kind: z.literal("web_search"), query: z.string() }),
  z.object({ kind: z.literal("web_fetch"), prompt: z.string().optional(), url: z.string() }),
  z.object({ kind: z.literal("skill"), name: z.string() }),
]);
