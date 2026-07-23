import { expect, test } from "bun:test";
import { access, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { executeGovernedToolCall, summarizeToolCall } from "./governed-tool-executor";
import type { Policy } from "./policy";

const policy: Policy = { rules: [
  { capability: "exec", decision: "deny", risk: "critical" },
  { capability: "exec", decision: "ask", risk: "high" },
] };

test("a policy denial blocks execution and records a structured refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-deny-"));
  const decisions: string[] = [];
  const result = await executeGovernedToolCall({
    call: { command: "sudo touch blocked.txt", kind: "bash" },
    governance: {
      recordDecision: async ({ decision }) => { decisions.push(decision); },
      requestApproval: async () => "deny",
    },
    onCompleted: async () => undefined,
    platform: "linux",
    policy,
    root,
    threadId: "thread",
  });

  expect(result.kind).toBe("refused");
  expect(JSON.parse(result.output)).toMatchObject({ capability: "exec", kind: "tool_refusal", reason: "policy_denied", risk: "critical" });
  expect(decisions).toEqual(["deny"]);
  expect(access(join(root, "blocked.txt"))).rejects.toThrow();
});

test("an approval denial blocks a high-risk command", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-ask-"));
  const result = await executeGovernedToolCall({
    call: { command: "rm -f blocked.txt", kind: "bash" },
    governance: {
      recordDecision: async () => undefined,
      requestApproval: async () => "deny",
    },
    onCompleted: async () => undefined,
    platform: "linux",
    policy,
    root,
    threadId: "thread",
  });

  expect(result.kind).toBe("refused");
  expect(JSON.parse(result.output)).toMatchObject({ kind: "tool_refusal", reason: "approval_denied" });
});

test("a resumed approval denial refuses without recording a duplicate decision", async () => {
  let recorded = false;
  const result = await executeGovernedToolCall({
    approvalResolution: "deny",
    call: { command: "rm -f blocked.txt", kind: "bash" },
    governance: {
      recordDecision: async () => { recorded = true; },
      requestApproval: async () => "allow",
    },
    onCompleted: async () => undefined,
    platform: "linux",
    policy,
    root: ".",
    threadId: "thread",
  });

  expect(result.kind).toBe("refused");
  expect(JSON.parse(result.output)).toMatchObject({ kind: "tool_refusal", reason: "approval_denied" });
  expect(recorded).toBe(false);
});

test("redacts credentials from approval and audit summaries", () => {
  const summary = summarizeToolCall({ command: "curl -H 'Authorization: Bearer deep-secret' --api-key another-secret https://example.com", kind: "bash" });
  expect(summary).not.toContain("deep-secret");
  expect(summary).not.toContain("another-secret");
  expect(summary).toContain("[REDACTED]");
});

test("routes MCP execution through approval before invoking the server", async () => {
  let invoked = false;
  const result = await executeGovernedToolCall({
    call: { arguments: { title: "Release" }, kind: "mcp", name: "publish", risk: "high", serverId: "cms" },
    governance: { recordDecision: async () => undefined, requestApproval: async () => "allow" },
    onCompleted: async () => undefined,
    onMcp: async () => { invoked = true; return { published: true }; },
    platform: "linux",
    policy,
    root: ".",
    threadId: "thread",
  });
  expect(invoked).toBe(true);
  expect(result).toEqual({ kind: "executed", output: '{"published":true}', succeeded: true });
});

test("does not invoke MCP when approval is denied", async () => {
  let invoked = false;
  const result = await executeGovernedToolCall({
    call: { arguments: {}, kind: "mcp", name: "publish", serverId: "cms" },
    governance: { recordDecision: async () => undefined, requestApproval: async () => "deny" },
    onCompleted: async () => undefined,
    onMcp: async () => { invoked = true; return {}; },
    platform: "linux",
    policy,
    root: ".",
    threadId: "thread",
  });
  expect(invoked).toBe(false);
  expect(result.kind).toBe("refused");
});

const readPolicy: Policy = { rules: [{ capability: "read", decision: "allow", risk: "low" }] };

test("resolves a skill's body and directory onto the tool call", async () => {
  const result = await executeGovernedToolCall({
    call: { kind: "skill", name: "deploy-checklist" },
    governance: { recordDecision: async () => undefined, requestApproval: async () => "allow" },
    onCompleted: async () => undefined,
    platform: "linux",
    policy: readPolicy,
    root: ".",
    skills: new Map([["deploy-checklist", { body: "1. Run tests\n2. Tag release", directory: "/home/user/.config/relay/skills/deploy-checklist" }]]),
    threadId: "thread",
  });
  expect(result).toEqual({
    kind: "executed",
    output: "Skill directory: /home/user/.config/relay/skills/deploy-checklist\n\n---\n\n1. Run tests\n2. Tag release",
    succeeded: true,
  });
});

test("an unresolvable skill name reports back to the model instead of throwing", async () => {
  const result = await executeGovernedToolCall({
    call: { kind: "skill", name: "does-not-exist" },
    governance: { recordDecision: async () => undefined, requestApproval: async () => "allow" },
    onCompleted: async () => undefined,
    platform: "linux",
    policy: readPolicy,
    root: ".",
    skills: new Map(),
    threadId: "thread",
  });
  expect(result).toEqual({ kind: "executed", output: "Unknown skill: does-not-exist", succeeded: true });
});
