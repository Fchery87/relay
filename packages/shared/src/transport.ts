import { z } from "zod";

const id = z.string().min(1).max(256);
const projectPath = z.string().min(1).max(4096);

export const reviewCommentTransportSchema = z.object({
  commentId: id,
  content: z.string().min(1).max(100_000),
  endLine: z.number().int().positive(),
  filePath: z.string().min(1).max(4096),
  startLine: z.number().int().positive(),
}).refine((comment) => comment.endLine >= comment.startLine, { message: "Review comment range is invalid" });

export const queuedMessageSchema = z.object({
  content: z.string().min(1).max(1_000_000),
  modelId: z.string().min(1).max(256),
  projectPath,
  reviewComments: z.array(reviewCommentTransportSchema).max(1_000),
  threadId: id,
  thinkingLevel: z.enum(["none", "low", "medium", "high"]),
});

export const queuedCommandSchema = z.object({
  command: z.string().min(1).max(1_000_000),
  commandId: id,
  projectPath,
  threadId: id,
});

export const approvalResolutionSchema = z.object({
  decision: z.enum(["pending", "allow", "deny"]),
});

export type QueuedCommand = z.infer<typeof queuedCommandSchema>;
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
