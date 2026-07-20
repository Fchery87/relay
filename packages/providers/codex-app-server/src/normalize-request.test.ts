import { expect, test } from "bun:test";
import { normalizeCodexRequest } from "./normalize-request";
test("normalizes generated approval request discriminants", () => { const normalized = normalizeCodexRequest({ method: "item/commandExecution/requestApproval", id: "r1" as any, params: {} as any }); expect(normalized).toMatchObject({ kind: "approval", capability: "exec", id: "r1" }); });
test("normalizes generated MCP elicitation discriminant", () => { const normalized = normalizeCodexRequest({ method: "mcpServer/elicitation/request", id: "r2" as any, params: {} as any }); expect(normalized.kind).toBe("mcp-elicitation"); });
