import { readFile } from "node:fs/promises";
import { z } from "zod";

import type { ToolCall } from "./tool-executor";

export const capabilitySchema = z.enum(["read", "edit", "exec", "task", "search"]);
export const riskSchema = z.enum(["low", "high", "critical"]);
export const policyDecisionSchema = z.enum(["allow", "deny", "ask"]);
export const policySchema = z.object({
  rules: z.array(z.object({ capability: capabilitySchema, decision: policyDecisionSchema, risk: riskSchema })),
});

export type Capability = z.infer<typeof capabilitySchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type Policy = z.infer<typeof policySchema>;
export type RiskTier = z.infer<typeof riskSchema>;

export function evaluatePolicy({ capability, policy, risk }: { capability: Capability; policy: Policy; risk: RiskTier }): PolicyDecision {
  return policy.rules.find((rule) => rule.capability === capability && rule.risk === risk)?.decision ?? "deny";
}

export function classifyToolCall(call: ToolCall): { capability: Capability; risk: RiskTier } {
  if (call.kind === "mcp") return { capability: "exec", risk: call.risk ?? "high" };
  if (call.kind === "task") return { capability: "task", risk: "low" };
  if (call.kind === "read") return { capability: "read", risk: isSensitivePath(call.path) ? "critical" : "low" };
  if (call.kind === "edit") return { capability: "edit", risk: isSensitivePath(call.path) ? "critical" : "low" };
  if (call.kind === "web_search") return { capability: "search", risk: "low" };
  if (call.kind === "web_fetch") return { capability: "search", risk: "low" };
  const normalized = call.command.toLowerCase().replaceAll(/\s+/g, " ").trim();
  if (/\bsudo\b|\brm\s+-[^\n]*r[^\n]*f[^\n]*\s+\/(?:\s|$)|\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba)?sh\b|(?:^|\s)(?:env|printenv)(?:\s|$)|\.env(?:\.[\w-]+)?|\.ssh(?:\/|\s)|\.relay(?:\/|\s)|process\.env|bun\.env|\/proc\/[^\s]+\/environ/.test(normalized)) {
    return { capability: "exec", risk: "critical" };
  }
  if (/\brm\b|\bgit\s+push\b|\b(?:npm|pnpm|yarn|bun)\s+(?:add|install)\b|\b(?:curl|wget)\b/.test(normalized)) {
    return { capability: "exec", risk: "high" };
  }
  return { capability: "exec", risk: "low" };
}

function isSensitivePath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part === ".env" || part.startsWith(".env.") || part === ".ssh" || part === ".relay" || /^(?:credentials|secrets?)(?:\.|$)/i.test(part));
}

export async function loadPolicy({ path }: { path: string }): Promise<Policy> {
  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  return policySchema.parse(input);
}
