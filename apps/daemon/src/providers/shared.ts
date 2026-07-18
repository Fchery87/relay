import { z } from "zod";

/** Shared schema for parsing tool calls across providers. */
export const toolCallSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), path: z.string() }),
  z.object({ content: z.string(), kind: z.literal("edit"), path: z.string() }),
  z.object({ command: z.string(), kind: z.literal("bash") }),
  z.object({ capabilities: z.array(z.enum(["read", "edit", "exec", "task"])), kind: z.literal("task"), role: z.string(), task: z.string() }),
  z.object({ kind: z.literal("web_search"), query: z.string() }),
  z.object({ kind: z.literal("web_fetch"), prompt: z.string().optional(), url: z.string() }),
]);
