import { expect, test } from "bun:test";

import { join } from "node:path";
import { ALLOW_ALL_POLICY, classifyToolCall, effectivePolicy, evaluatePolicy, loadPolicy, type Policy } from "./policy";

const policy: Policy = {
  rules: [
    { capability: "exec", decision: "deny", risk: "critical" },
    { capability: "exec", decision: "ask", risk: "high" },
    { capability: "exec", decision: "allow", risk: "low" },
    { capability: "read", decision: "allow", risk: "low" },
  ],
};

test("evaluates capability and risk rules with a deny fallback", () => {
  expect(evaluatePolicy({ capability: "read", policy, risk: "low" })).toBe("allow");
  expect(evaluatePolicy({ capability: "exec", policy, risk: "high" })).toBe("ask");
  expect(evaluatePolicy({ capability: "exec", policy, risk: "critical" })).toBe("deny");
  expect(evaluatePolicy({ capability: "task", policy, risk: "low" })).toBe("deny");
});

test("classifies destructive commands before policy evaluation", () => {
  expect(classifyToolCall({ command: "pwd", kind: "bash" })).toEqual({ capability: "exec", risk: "low" });
  expect(classifyToolCall({ command: "rm -rf build", kind: "bash" })).toEqual({ capability: "exec", risk: "high" });
  expect(classifyToolCall({ command: "sudo rm -rf /", kind: "bash" })).toEqual({ capability: "exec", risk: "critical" });
});

test("classifies credential reads as critical", () => {
  expect(classifyToolCall({ kind: "read", path: ".env.local" })).toEqual({ capability: "read", risk: "critical" });
  expect(classifyToolCall({ command: "cat .env.local", kind: "bash" })).toEqual({ capability: "exec", risk: "critical" });
  expect(classifyToolCall({ command: "printenv", kind: "bash" })).toEqual({ capability: "exec", risk: "critical" });
});

test("classifies MCP tools from their declared risk and defaults to high", () => {
  expect(classifyToolCall({ arguments: {}, kind: "mcp", name: "search", risk: "low", serverId: "docs" })).toEqual({ capability: "exec", risk: "low" });
  expect(classifyToolCall({ arguments: {}, kind: "mcp", name: "publish", serverId: "cms" })).toEqual({ capability: "exec", risk: "high" });
  expect(classifyToolCall({ arguments: {}, kind: "mcp", name: "rotate_key", risk: "critical", serverId: "admin" })).toEqual({ capability: "exec", risk: "critical" });
});

test("loads and validates the daemon policy file", async () => {
  const loaded = await loadPolicy({ path: join(import.meta.dir, "..", "policy.json") });
  expect(evaluatePolicy({ capability: "exec", policy: loaded, risk: "high" })).toBe("ask");
  expect(evaluatePolicy({ capability: "exec", policy: loaded, risk: "critical" })).toBe("deny");
});

test("full-access profile and yolo mode allow every capability at every risk", () => {
  for (const derived of [
    effectivePolicy({ base: policy, profile: "full-access", yolo: false }),
    effectivePolicy({ base: policy, profile: "workspace-write", yolo: true }),
    effectivePolicy({ base: policy, profile: "read-only", yolo: true }),
  ]) {
    expect(evaluatePolicy({ capability: "exec", policy: derived, risk: "critical" })).toBe("allow");
    expect(evaluatePolicy({ capability: "edit", policy: derived, risk: "low" })).toBe("allow");
    expect(evaluatePolicy({ capability: "task", policy: derived, risk: "high" })).toBe("allow");
  }
});

test("read-only profile denies mutation but keeps reads and search", () => {
  const derived = effectivePolicy({ base: policy, profile: "read-only", yolo: false });
  expect(evaluatePolicy({ capability: "read", policy: derived, risk: "low" })).toBe("allow");
  expect(evaluatePolicy({ capability: "search", policy: derived, risk: "low" })).toBe("allow");
  expect(evaluatePolicy({ capability: "read", policy: derived, risk: "critical" })).toBe("ask");
  expect(evaluatePolicy({ capability: "edit", policy: derived, risk: "low" })).toBe("deny");
  expect(evaluatePolicy({ capability: "exec", policy: derived, risk: "low" })).toBe("deny");
});

test("workspace-write profile without yolo returns the base policy unchanged", () => {
  expect(effectivePolicy({ base: policy, profile: "workspace-write", yolo: false })).toBe(policy);
});
