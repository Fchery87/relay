import { expect, test } from "bun:test";

import { McpClient, StreamableHttpTransport, type McpRequest, type McpTransport } from "./mcp-client";

test("streamable HTTP sends stateless metadata and routing headers", async () => {
  const requests: Array<{ body: unknown; headers: Headers }> = [];
  const transport = new StreamableHttpTransport({
    fetcher: async (_url, init) => {
      requests.push({ body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    },
    url: "https://mcp.example.test",
  });
  await transport.request({ method: "server/discover", params: {} });
  expect(requests[0]?.headers.get("Mcp-Method")).toBe("server/discover");
  expect(requests[0]?.headers.get("Mcp-Name")).toBe("relay");
  expect(requests[0]?.body).toMatchObject({ method: "server/discover", params: { _meta: { clientInfo: { name: "relay" }, protocolVersion: "2026-07-28" } } });
  expect(requests[0]?.headers.has("Mcp-Session-Id")).toBe(false);
});

test("discovers tools once until ttlMs expires", async () => {
  let now = 100;
  let calls = 0;
  const transport: McpTransport = { request: async ({ method }) => {
    if (method === "server/discover") return { capabilities: { tools: true } };
    calls += 1;
    return { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" }, annotations: { risk: "low" } }], ttlMs: 50 };
  } };
  const client = new McpClient({ now: () => now, serverId: "server", transport });
  expect((await client.listTools()).map((tool) => tool.name)).toEqual(["search"]);
  await client.listTools();
  expect(calls).toBe(1);
  now = 151;
  await client.listTools();
  expect(calls).toBe(2);
});

test("calls a discovered tool with validated arguments", async () => {
  const requests: string[] = [];
  const transport: McpTransport = { request: async ({ method }) => {
    requests.push(method);
    if (method === "server/discover") return { capabilities: { tools: true } };
    if (method === "tools/list") return { tools: [{ name: "echo", inputSchema: { type: "object" }, annotations: { risk: "high" } }], ttlMs: 1000 };
    return { content: [{ type: "text", text: "hello" }] };
  } };
  const client = new McpClient({ serverId: "fixture", transport });
  expect(await client.callTool({ arguments: { value: "hello" }, name: "echo" })).toMatchObject({ content: [{ text: "hello" }] });
  expect(requests).toEqual(["server/discover", "tools/list", "tools/call"]);
});

test("times out an unresponsive HTTP server", async () => {
  const transport = new StreamableHttpTransport({ fetcher: async () => new Promise<Response>(() => undefined), timeoutMs: 10, url: "https://mcp.example.test" });
  await expect(transport.request({ method: "server/discover" })).rejects.toThrow("timed out");
});

test("rejects invalid JSON Schema 2020-12 tool definitions", async () => {
  const transport: McpTransport = { request: async ({ method }) => method === "server/discover" ? { capabilities: { tools: true } } : { tools: [{ inputSchema: { type: "not-a-json-type" }, name: "bad" }], ttlMs: 1000 } };
  await expect(new McpClient({ serverId: "bad", transport }).listTools()).rejects.toThrow();
});

test("validates tool arguments before sending a call", async () => {
  let called = false;
  const transport: McpTransport = { request: async ({ method }) => {
    if (method === "server/discover") return { capabilities: { tools: true } };
    if (method === "tools/list") return { tools: [{ inputSchema: { additionalProperties: false, properties: { query: { type: "string" } }, required: ["query"], type: "object" }, name: "search" }], ttlMs: 1000 };
    called = true; return {};
  } };
  const client = new McpClient({ serverId: "docs", transport });
  await expect(client.callTool({ arguments: {}, name: "search" })).rejects.toThrow("arguments");
  expect(called).toBe(false);
});

test("validates schemas with ids without cache collisions", async () => {
  const createClient = (serverId: string) => new McpClient({ serverId, transport: { request: async ({ method }) => {
    if (method === "server/discover") return { capabilities: { tools: true } };
    if (method === "tools/list") return { tools: [{ inputSchema: { $id: "https://example.test/shared", type: "object" }, name: "echo" }], ttlMs: 1000 };
    return {};
  } } });
  const first = createClient("first");
  await first.listTools();
  expect(await first.callTool({ arguments: {}, name: "echo" })).toEqual({});
  const second = createClient("second");
  await second.listTools();
  expect(await second.callTool({ arguments: {}, name: "echo" })).toEqual({});
}, 15_000);

test("validates JSON Schema output definitions and structured tool output", async () => {
  let invalidDefinition = true;
  const transport: McpTransport = { request: async ({ method }) => {
    if (method === "server/discover") return { capabilities: { tools: true } };
    if (method === "tools/list") return { tools: [{ inputSchema: { type: "object" }, name: "lookup", outputSchema: invalidDefinition ? { type: "wrong" } : { properties: { count: { type: "number" } }, required: ["count"], type: "object" } }], ttlMs: 0 };
    return { structuredContent: { count: "not-a-number" } };
  } };
  const client = new McpClient({ serverId: "docs", transport });
  await expect(client.listTools()).rejects.toThrow();
  invalidDefinition = false;
  await expect(client.callTool({ arguments: {}, name: "lookup" })).rejects.toThrow("output");
});

test("bounds pathological regular-expression validation time", async () => {
  const transport: McpTransport = { request: async ({ method }) => method === "server/discover" ? { capabilities: { tools: true } } : { tools: [{ inputSchema: { properties: { value: { pattern: "^(a+)+$", type: "string" } }, type: "object" }, name: "regex" }], ttlMs: 1000 } };
  const client = new McpClient({ serverId: "hostile", transport });
  await expect(client.callTool({ arguments: { value: `${"a".repeat(30_000)}!` }, name: "regex" })).rejects.toThrow(/timed out|arguments|unsafe regular expression/);
}, 10_000);

test("polls Tasks extension handles and reports status until completion", async () => {
  let polls = 0;
  const statuses: string[] = [];
  const transport: McpTransport = { request: async ({ method }) => {
    if (method === "server/discover") return { capabilities: { tasks: true, tools: true } };
    if (method === "tools/list") return { tools: [{ inputSchema: { type: "object" }, name: "long" }], ttlMs: 1000 };
    if (method === "tools/call") return { task: { id: "task-1", status: "working" } };
    polls += 1;
    return polls === 1 ? { task: { id: "task-1", status: "working" } } : { result: { content: [{ text: "done", type: "text" }] }, task: { id: "task-1", status: "completed" } };
  } };
  const client = new McpClient({ serverId: "tasks", sleep: async () => undefined, transport });
  expect(await client.callTool({ arguments: {}, name: "long", onTaskStatus: ({ status }) => { statuses.push(status); } })).toMatchObject({ content: [{ text: "done" }] });
  expect(statuses).toEqual(["working", "working", "completed"]);
});

test("resumes multi-round-trip elicitation with opaque request state", async () => {
  const calls: McpRequest[] = [];
  const transport: McpTransport = { request: async (input) => {
    if (input.method === "server/discover") return { capabilities: { tools: true } };
    if (input.method === "tools/list") return { tools: [{ inputSchema: { type: "object" }, name: "book" }], ttlMs: 1000 };
    calls.push(input);
    return calls.length === 1 ? { prompts: [{ id: "date", label: "Date" }], requestState: "opaque-state", type: "input_required" } : { content: [{ text: "booked", type: "text" }] };
  } };
  const client = new McpClient({ serverId: "travel", transport });
  expect(await client.callTool({ arguments: {}, name: "book", onInputRequired: async () => ({ date: "2026-08-01" }) })).toMatchObject({ content: [{ text: "booked" }] });
  expect(calls[1]?.params).toMatchObject({ inputResponses: { date: "2026-08-01" }, requestState: "opaque-state" });
});
