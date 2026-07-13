import { expect, test } from "bun:test";

import { mcpServerConfigSchema, validateMcpToolSchema } from "./mcp";

test("accepts secret-free HTTP and stdio server configuration", () => {
  expect(mcpServerConfigSchema.parse({ name: "docs", transport: { kind: "http", url: "https://mcp.example.test", authEnvVar: "DOCS_MCP_TOKEN" } }).transport.kind).toBe("http");
  expect(mcpServerConfigSchema.parse({ name: "local", transport: { kind: "stdio", command: "bun", args: ["server.ts"] } }).transport.kind).toBe("stdio");
  expect(() => mcpServerConfigSchema.parse({ name: "bad", transport: { kind: "http", url: "https://example.test", token: "secret" } })).toThrow();
  expect(() => mcpServerConfigSchema.parse({ name: "bad", transport: { kind: "stdio", command: "server", args: ["--token", "secret"] } })).toThrow("credentials");
});

test("bounds JSON Schema and rejects external references", () => {
  expect(validateMcpToolSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"] })).toEqual({ type: "object", properties: { query: { type: "string" } }, required: ["query"] });
  expect(() => validateMcpToolSchema({ $ref: "https://example.test/schema.json" })).toThrow("External JSON Schema references");
  let schema: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < 20; index += 1) schema = { type: "array", items: schema };
  expect(() => validateMcpToolSchema(schema)).toThrow("depth");
});
