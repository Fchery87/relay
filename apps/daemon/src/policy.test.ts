import { expect, test } from "bun:test";

import { join } from "node:path";
import { classifyToolCall, evaluatePolicy, loadPolicy, type Policy } from "./policy";

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
