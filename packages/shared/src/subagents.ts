import { z } from "zod";

import { DEFAULT_MODEL_ID, thinkingLevelSchema } from "./model-catalog";

export const capabilitySchema = z.enum(["read", "edit", "exec", "task"]);
export const subagentRoleSchema = z.object({
  capabilities: z.array(capabilitySchema),
  contextMode: z.enum(["fresh", "forked"]),
  description: z.string().min(1),
  maxTurns: z.number().int().positive().max(100),
  modelId: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  thinkingLevel: thinkingLevelSchema,
  writer: z.boolean(),
});
export const subagentResultSchema = z.object({
  artifacts: z.array(z.string()),
  findings: z.array(z.string()),
  status: z.enum(["success", "failed"]),
  summary: z.string(),
});

export type Capability = z.infer<typeof capabilitySchema>;
export type SubagentRole = z.infer<typeof subagentRoleSchema>;
export type SubagentResult = z.infer<typeof subagentResultSchema>;

const READ_ONLY: Capability[] = ["read", "task"];
const WRITER: Capability[] = ["read", "edit", "exec", "task"];

function role(name: string, description: string, options: Partial<SubagentRole> = {}): SubagentRole {
  const writer = options.writer ?? false;
  return subagentRoleSchema.parse({
    capabilities: writer ? WRITER : READ_ONLY,
    contextMode: writer ? "forked" : "fresh",
    description,
    maxTurns: 20,
    modelId: DEFAULT_MODEL_ID,
    name,
    prompt: `You are the ${name} subagent. ${description} Return a concise Subagent Result Contract.`,
    thinkingLevel: "none",
    writer,
    ...options,
  });
}

export const DEFAULT_SUBAGENT_ROLES: readonly SubagentRole[] = [
  role("explore", "Map the codebase with file and line evidence."),
  role("plan", "Produce an ordered and verifiable implementation plan."),
  role("researcher", "Gather sourced facts from project documentation and available tools.", { maxTurns: 25 }),
  role("oracle", "Challenge assumptions and surface the most important risks.", { maxTurns: 25 }),
  role("reviewer", "Review correctness, regressions, and missing tests.", { maxTurns: 30 }),
  role("reviewer-security", "Review security, privacy, policy bypasses, and trust boundaries.", { maxTurns: 30 }),
  role("evaluator", "Grade implementation evidence against the active contract.", { maxTurns: 24 }),
  role("build", "Implement a focused change and verify it.", { writer: true, maxTurns: 40 }),
  role("worker", "Execute an approved task with narrow, coherent edits.", { writer: true, maxTurns: 40 }),
];

export function narrowCapabilities({ child, depth, parent }: { child: readonly Capability[]; depth: number; parent: readonly Capability[] }): Capability[] {
  if (depth < 1 || depth > 2) throw new Error("Subagent depth must be between 1 and 2");
  const ceiling = new Set(parent);
  for (const capability of child) if (!ceiling.has(capability)) throw new Error(`Child cannot grant ${capability} beyond the parent capability ceiling`);
  return [...new Set(child)];
}
