import type { MachinePlatform } from "@relay/shared";

import { classifyToolCall, evaluatePolicy, type Capability, type Policy, type PolicyDecision, type RiskTier } from "./policy";
import { executeToolCall, type ToolCall } from "./tool-executor";

export interface GovernanceGateway {
  recordDecision(input: { capability: Capability; decision: Exclude<PolicyDecision, "ask">; risk: RiskTier; summary: string; threadId: string }): Promise<unknown>;
  requestApproval(input: { capability: Capability; risk: RiskTier; summary: string; threadId: string }): Promise<"allow" | "deny">;
}

export type GovernedToolResult =
  | { kind: "executed"; output: string; succeeded: boolean }
  | { kind: "refused"; output: string };

export async function executeGovernedToolCall({ call, governance, onCompleted, onMcp, onOutput, onTask, platform, policy, root, threadId }: {
  call: ToolCall;
  governance: GovernanceGateway;
  onCompleted(event: { summary: string; tool: "bash" | "edit" | "mcp" | "read" | "task" }): Promise<void>;
  onMcp?: (call: Extract<ToolCall, { kind: "mcp" }>) => Promise<unknown>;
  onOutput?: (output: string) => Promise<void>;
  onTask?: (call: Extract<ToolCall, { kind: "task" }>) => Promise<string>;
  platform: MachinePlatform;
  policy: Policy;
  root: string;
  threadId: string;
}): Promise<GovernedToolResult> {
  const classification = classifyToolCall(call);
  const decision = evaluatePolicy({ ...classification, policy });
  const summary = summarizeToolCall(call);
  if (decision === "deny") {
    await governance.recordDecision({ ...classification, decision, summary, threadId });
    return { kind: "refused", output: refusal({ ...classification, reason: "policy_denied" }) };
  }
  if (decision === "ask") {
    const resolution = await governance.requestApproval({ ...classification, summary, threadId });
    if (resolution === "deny") return { kind: "refused", output: refusal({ ...classification, reason: "approval_denied" }) };
  } else {
    await governance.recordDecision({ ...classification, decision, summary, threadId });
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
  return `${call.kind} ${call.path}`;
}

function redactCredentials(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^'"\s]+/gi, "$1[REDACTED]")
    .replace(/(--(?:api[-_]?key|token|password|secret)\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET))=([^\s]+)/gi, "$1=[REDACTED]");
}
