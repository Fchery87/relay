import { z } from "zod";

export const toolEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command.output"), output: z.string(), threadId: z.string().min(1) }),
  z.object({
    kind: z.literal("tool.completed"),
    summary: z.string(),
    threadId: z.string().min(1),
    tool: z.enum(["bash", "edit", "mcp", "read", "task"]),
  }),
]);

export type ToolEvent = z.infer<typeof toolEventSchema>;
