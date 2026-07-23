import type { MachinePlatform } from "@relay/shared";

import { classifyToolCall, evaluatePolicy, type Capability, type Policy, type PolicyDecision, type RiskTier } from "./policy";
import { executeToolCall, type CompletedTool, type ToolCall } from "./tool-executor";
import { toolContract } from "./tool-registry";

export interface GovernanceGateway {
  recordDecision(input: { capability: Capability; decision: Exclude<PolicyDecision, "ask">; risk: RiskTier; summary: string; threadId: string }): Promise<unknown>;
  requestApproval(input: { capability: Capability; risk: RiskTier; summary: string; threadId: string }): Promise<"allow" | "deny">;
  createApproval?(input: { capability: Capability; continuationJson: string; risk: RiskTier; summary: string; threadId: string; turnId: string }): Promise<string>;
  getApproval?(input: { approvalId: string }): Promise<{ continuationJson?: string; decision: "pending" | "allow" | "deny"; threadId: string; turnId?: string } | null>;
}

export type GovernedToolResult =
  | { kind: "executed"; output: string; succeeded: boolean }
  | { kind: "refused"; output: string };

export async function executeGovernedToolCall({ approvalResolution, call, governance, onCompleted, onMcp, onOutput, onTask, platform, policy, root, skills, threadId }: {
  approvalResolution?: "allow" | "deny";
  call: ToolCall;
  governance: GovernanceGateway;
  onCompleted(event: { summary: string; tool: CompletedTool }): Promise<void>;
  onMcp?: (call: Extract<ToolCall, { kind: "mcp" }>) => Promise<unknown>;
  onOutput?: (output: string) => Promise<void>;
  onTask?: (call: Extract<ToolCall, { kind: "task" }>) => Promise<string>;
  platform: MachinePlatform;
  policy: Policy;
  root: string;
  skills?: Map<string, { body: string; directory: string }>;
  threadId: string;
}): Promise<GovernedToolResult> {
  const contract = toolContract(call);
  const classification = classifyToolCall(call);
  const decision = approvalResolution ?? evaluatePolicy({ ...classification, policy });
  const summary = summarizeToolCall(call);
  if (decision === "deny") {
    if (approvalResolution === undefined) {
      await governance.recordDecision({ ...classification, decision, summary, threadId });
    }
    return {
      kind: "refused",
      output: refusal({
        ...classification,
        reason: approvalResolution === "deny" ? "approval_denied" : "policy_denied",
      }),
    };
  }
  if (decision === "ask") {
    const resolution = await governance.requestApproval({ ...classification, summary, threadId });
    if (resolution === "deny") return { kind: "refused", output: refusal({ ...classification, reason: "approval_denied" }) };
  } else if (approvalResolution === undefined) {
    await governance.recordDecision({ ...classification, decision, summary, threadId });
  }
  // Resolve skill body for skill tool calls
  if (call.kind === "skill" && skills) {
    const skill = skills.get(call.name);
    call.body = skill ? `Skill directory: ${skill.directory}\n\n---\n\n${skill.body}` : `Unknown skill: ${call.name}`;
    call.directory = skill?.directory;
  }
  return { kind: "executed", ...await executeToolCall({ call, onCompleted, onMcp, onOutput, onTask, platform, root }) };
}

function refusal({ capability, reason, risk }: { capability: Capability; reason: "approval_denied" | "policy_denied"; risk: RiskTier }): string {
  return JSON.stringify({ capability, kind: "tool_refusal", reason, risk });
}

export function summarizeToolCall(call: ToolCall): string {
  if (call.kind === "mcp") return `mcp ${call.serverId}/${call.name}`;
  if (call.kind === "task") return `task ${call.role}`;
  if (call.kind === "bash") return redactCredentials(call.command);
  if (call.kind === "skill") return `skill ${call.name}`;
  if (call.kind === "todo") return "todo";
  if (call.kind === "grep") return `grep ${call.pattern}`;
  if (call.kind === "glob") return `glob ${call.pattern}`;
  if (call.kind === "web_search") return `web search: ${call.query}`;
  if (call.kind === "web_fetch") return `web fetch: ${call.url}`;
  return `${call.kind} ${"path" in call ? call.path : ""}`;
}

function redactCredentials(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^'"\s]+/gi, "$1[REDACTED]")
    .replace(/(--(?:api[-_]?key|token|password|secret)\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET))=([^\s]+)/gi, "$1=[REDACTED]");
}
