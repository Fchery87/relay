import { expect, test } from "bun:test";

import { McpRegistry } from "./mcp-registry";
import type { McpTransport } from "./mcp-client";

const server = { _id: "server", approvalThreadId: "thread", enabled: true, name: "Local", status: "disconnected", transport: { args: ["danger"], command: "bash", kind: "stdio" as const } };

test("does not spawn an unapproved stdio server", async () => {
  let created = false;
  const registry = new McpRegistry({
    createTransport: () => { created = true; return { request: async () => ({}) }; }, env: {},
    gateway: { listServers: async () => [server], reportStatus: async () => undefined },
    governance: { recordDecision: async () => undefined, requestApproval: async ({ risk, summary }) => { expect(risk).toBe("critical"); expect(summary).toContain("bash danger"); return "deny"; } },
  });
  expect(await registry.listTools()).toEqual([]);
  expect(created).toBe(false);
});

test("never lowers an MCP tool call below high risk from server annotations", async () => {
  const transport: McpTransport = { request: async ({ method }) => method === "server/discover" ? { capabilities: { tools: true } } : { tools: [{ annotations: { risk: "low" }, inputSchema: { type: "object" }, name: "danger" }], ttlMs: 1000 } };
  const registry = new McpRegistry({
    createTransport: () => transport, env: {}, gateway: { listServers: async () => [server], reportStatus: async () => undefined },
    governance: { recordDecision: async () => undefined, requestApproval: async () => "allow" },
  });
  expect(await registry.listTools()).toMatchObject([{ name: "danger", risk: "high" }]);
});

test("persists only a generic error when a server echoes credentials", async () => {
  const errors: Array<string | undefined> = [];
  const registry = new McpRegistry({
    createTransport: () => ({ request: async () => { throw new Error("TOP_SECRET"); } }), env: { TOKEN: "TOP_SECRET" },
    gateway: { listServers: async () => [{ ...server, transport: { args: [], command: "fixture", envVarNames: ["TOKEN"], kind: "stdio" } }], reportStatus: async ({ error }) => { errors.push(error); } },
    governance: { recordDecision: async () => undefined, requestApproval: async () => "allow" },
  });
  await registry.listTools();
  expect(errors.join(" ")).not.toContain("TOP_SECRET");
  expect(errors.at(-1)).toContain("daemon logs");
});

test("redacts credentials from cloud-bound elicitation prompts and task ids", async () => {
  const secret = "OAUTH_ACCESS_VALUE";
  const refreshedSecret = "OAUTH_REFRESHED_VALUE";
  const refreshSecret = "OAUTH_REFRESH_VALUE";
  let callCount = 0;
  let storedAccessToken = secret;
  const transport: McpTransport = { request: async ({ method }) => {
    if (method === "server/discover") return { capabilities: { tasks: true, tools: true } };
    if (method === "tools/list") return { tools: [{ inputSchema: { type: "object" }, name: "prompt" }, { inputSchema: { type: "object" }, name: "task" }], ttlMs: 1000 };
    if (method === "tasks/get") return { result: {}, task: { id: refreshedSecret, status: "completed" } };
    callCount += 1;
    storedAccessToken = refreshedSecret;
    if (callCount === 1) return { prompts: [{ [refreshSecret]: refreshedSecret }], requestState: "opaque", type: "input_required" };
    if (callCount === 2) return {};
    return { task: { id: refreshedSecret, status: "working" } };
  } };
  const oauthServer = { ...server, transport: { kind: "http" as const, oauthIssuer: "https://issuer.test", url: "https://mcp.example.test" } };
  const registry = new McpRegistry({ createTransport: () => transport, env: {}, gateway: { listServers: async () => [oauthServer], reportStatus: async () => undefined }, governance: { recordDecision: async () => undefined, requestApproval: async () => "allow" }, oauthStore: { load: async () => ({ accessToken: storedAccessToken, clientId: "client", expiresAt: Date.now() + 1000, refreshToken: refreshSecret }), save: async () => undefined } });
  await registry.listTools();
  let prompts: unknown[] = [];
  await registry.callTool({ arguments: {}, name: "prompt", onInputRequired: async (input) => { prompts = input.prompts; return {}; }, serverId: "server" });
  const taskIds: string[] = [];
  await registry.callTool({ arguments: {}, name: "task", onTaskStatus: ({ id }) => { taskIds.push(id); }, serverId: "server" });
  expect(JSON.stringify(prompts)).not.toContain(secret);
  expect(JSON.stringify(prompts)).not.toContain(refreshedSecret);
  expect(JSON.stringify(prompts)).not.toContain(refreshSecret);
  expect(taskIds.join(" ")).not.toContain(secret);
  expect(taskIds.join(" ")).not.toContain(refreshedSecret);
});
