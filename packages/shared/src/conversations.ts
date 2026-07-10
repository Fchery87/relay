import { z } from "zod";

export const messageRoleSchema = z.enum(["assistant", "user"]);
export const messageStatusSchema = z.enum(["complete", "queued", "streaming"]);

export const messageSchema = z.object({
  content: z.string(),
  role: messageRoleSchema,
  status: messageStatusSchema,
  threadId: z.string().min(1),
});

export type Message = z.infer<typeof messageSchema>;
export type MessageRole = z.infer<typeof messageRoleSchema>;
export type MessageStatus = z.infer<typeof messageStatusSchema>;
