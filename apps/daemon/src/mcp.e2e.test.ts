import { afterAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { executeGovernedToolCall } from "./governed-tool-executor";
import { McpClient, StdioTransport, StreamableHttpTransport } from "./mcp-client";
import { fixtureResult } from "./fixtures/mcp-server";

const governance = { recordDecision: async () => undefined, requestApproval: async () => "allow" as const };
const policy = { rules: [{ capability: "exec" as const, decision: "allow" as const, risk: "low" as const }] };
const httpFixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const envelope = await request.json() as { id: number; method: string; params?: Record<string, unknown> };
  if (request.headers.get("Mcp-Method") !== envelope.method) return new Response("routing mismatch", { status: 400 });
  return Response.json({ id: envelope.id, jsonrpc: "2.0", result: fixtureResult(envelope) });
} });
afterAll(() => httpFixture.stop(true));

test("calls a fixture MCP server over streamable HTTP through governance", async () => {
  const transport = new StreamableHttpTransport({ url: `http://127.0.0.1:${httpFixture.port}` });
  const client = new McpClient({ serverId: "http-fixture", transport });
  const tools = await client.listTools();
  const result = await executeGovernedToolCall({ call: { arguments: { text: "http" }, kind: "mcp", name: tools[0]!.name, risk: tools[0]!.annotations?.risk, serverId: "http-fixture" }, governance, onCompleted: async () => undefined, onMcp: (call) => client.callTool(call), platform: "linux", policy, root: ".", threadId: "thread" });
  expect(result).toMatchObject({ kind: "executed", succeeded: true });
  expect(result.output).toContain("http");
});

test("calls a fixture MCP server over stdio through governance", async () => {
  const transport = new StdioTransport({ args: [fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url))], command: process.execPath });
  try {
    const client = new McpClient({ serverId: "stdio-fixture", transport });
    const tools = await client.listTools();
    const result = await executeGovernedToolCall({ call: { arguments: { text: "stdio" }, kind: "mcp", name: tools[0]!.name, risk: tools[0]!.annotations?.risk, serverId: "stdio-fixture" }, governance, onCompleted: async () => undefined, onMcp: (call) => client.callTool(call), platform: "linux", policy, root: ".", threadId: "thread" });
    expect(result.output).toContain("stdio");
  } finally {
    await transport.close();
  }
});
