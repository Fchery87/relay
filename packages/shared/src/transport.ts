import { z } from "zod";
import { capabilitySchema, subagentResultSchema } from "./subagents";

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

export const steeringMessagesSchema = z.array(z.object({ content: z.string().min(1).max(1_000_000) })).max(100);
export const stopStateSchema = z.object({ requested: z.boolean() });
export const queuedRestoreSchema = z.object({
  actionId: id,
  claimToken: id,
  checkpointId: id,
  commit: z.string().regex(/^[0-9a-f]{4,64}$/i),
  projectPath,
  threadId: id,
});
export const queuedComparisonSchema = z.object({
  claimToken: id,
  comparisonId: id,
  fromCommit: z.string().regex(/^[0-9a-f]{4,64}$/i),
  projectPath,
  threadId: id,
  toCommit: z.string().regex(/^[0-9a-f]{4,64}$/i),
});
export const queuedSubagentSchema = z.object({
  capabilities: z.array(capabilitySchema), claimToken: id, contextMode: z.enum(["fresh", "forked"]), depth: z.number().int().min(1).max(2),
  maxTurns: z.number().int().positive().max(100), modelId: id, parentRunId: id.optional(), projectPath, prompt: z.string(), roleName: id,
  runId: id, task: z.string().min(1).max(1_000_000), thinkingLevel: z.enum(["none", "low", "medium", "high"]), threadId: id, writer: z.boolean(),
});

export type QueuedCommand = z.infer<typeof queuedCommandSchema>;
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type SteeringMessages = z.infer<typeof steeringMessagesSchema>;
export type StopState = z.infer<typeof stopStateSchema>;
export type QueuedRestore = z.infer<typeof queuedRestoreSchema>;
export type QueuedComparison = z.infer<typeof queuedComparisonSchema>;
export type QueuedSubagent = z.infer<typeof queuedSubagentSchema>;
export { subagentResultSchema };
