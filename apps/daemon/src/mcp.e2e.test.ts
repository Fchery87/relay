import { afterAll, expect, test } from "bun:test";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { executeGovernedToolCall } from "./governed-tool-executor";
import { McpClient, StdioTransport, StreamableHttpTransport } from "./mcp-client";
import { fixtureResult } from "./fixtures/mcp-server";

const governance = { recordDecision: async () => undefined, requestApproval: async () => "allow" as const };
const policy = { rules: [{ capability: "exec" as const, decision: "allow" as const, risk: "low" as const }] };
async function findFreePort(): Promise<number | undefined> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(undefined));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() => resolve(port));
    });
  });
}

async function canUseStdio(): Promise<boolean> {
  const child = Bun.spawn([process.execPath, "-e", "process.stdin.on('data', () => {})"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  try {
    await child.stdin.write("probe\n");
    await child.stdin.flush();
    child.kill();
    await child.exited;
    return true;
  } catch {
    child.kill();
    return false;
  }
}

const httpPort = await findFreePort();
const httpFixture = httpPort === undefined ? undefined : (() => {
  try {
    return Bun.serve({ hostname: "127.0.0.1", port: httpPort, async fetch(request) {
      const envelope = await request.json() as { id: number; method: string; params?: Record<string, unknown> };
      if (request.headers.get("Mcp-Method") !== envelope.method) return new Response("routing mismatch", { status: 400 });
      return Response.json({ id: envelope.id, jsonrpc: "2.0", result: fixtureResult(envelope) });
    } });
  } catch {
    return undefined;
  }
})();
const stdioAvailable = await canUseStdio();
afterAll(() => httpFixture?.stop(true));

test.skipIf(httpFixture === undefined)("calls a fixture MCP server over streamable HTTP through governance", async () => {
  const transport = new StreamableHttpTransport({ url: `http://127.0.0.1:${httpFixture!.port}` });
  const client = new McpClient({ serverId: "http-fixture", transport });
  const tools = await client.listTools();
  const result = await executeGovernedToolCall({ call: { arguments: { text: "http" }, kind: "mcp", name: tools[0]!.name, risk: tools[0]!.annotations?.risk, serverId: "http-fixture" }, governance, onCompleted: async () => undefined, onMcp: (call) => client.callTool(call), platform: "linux", policy, root: ".", threadId: "thread" });
  expect(result).toMatchObject({ kind: "executed", succeeded: true });
  expect(result.output).toContain("http");
});

test.skipIf(!stdioAvailable)("calls a fixture MCP server over stdio through governance", async () => {
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
