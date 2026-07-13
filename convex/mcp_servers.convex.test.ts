import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { daemonVersion: "1", deviceToken: "device", lastHeartbeatAt: 1, name: "machine", platform: "linux" });
    const projectId = await ctx.db.insert("projects", { machineId, name: "relay", path: "/relay" });
    const threadId = await ctx.db.insert("threads", { projectId, status: "idle", title: "MCP setup" });
    return { machineId, projectId, threadId };
  });
}

test("creates secret-free MCP server config and lists it for its project", async () => {
  const t = convexTest(schema, modules);
  const { projectId, threadId } = await seed(t);
  const serverId = await t.mutation(api.mcp_servers.create, { name: "docs", projectId, threadId, transport: { authEnvVar: "DOCS_TOKEN", kind: "http", url: "https://mcp.example.test" } });
  const servers = await t.query(api.mcp_servers.listForProject, { projectId });
  expect(servers).toMatchObject([{ _id: serverId, enabled: true, name: "docs", status: "disconnected", transport: { authEnvVar: "DOCS_TOKEN", kind: "http" } }]);
  expect(JSON.stringify(servers)).not.toContain("secret-value");
});

test("allows only the owning daemon to report connection status", async () => {
  const t = convexTest(schema, modules);
  const { projectId, threadId } = await seed(t);
  const serverId = await t.mutation(api.mcp_servers.create, { name: "local", projectId, threadId, transport: { args: ["server.ts"], command: "bun", kind: "stdio" } });
  await expect(t.mutation(api.mcp_servers.reportStatus, { deviceToken: "wrong", error: "no", serverId, status: "error", toolCount: 0 })).rejects.toThrow("does not own");
  await t.mutation(api.mcp_servers.reportStatus, { deviceToken: "device", serverId, status: "connected", toolCount: 2 });
  expect(await t.query(api.mcp_servers.listForDaemon, { deviceToken: "device" })).toMatchObject([{ _id: serverId, status: "connected", toolCount: 2 }]);
});

test("updates and deletes MCP server configuration", async () => {
  const t = convexTest(schema, modules);
  const { projectId, threadId } = await seed(t);
  const serverId = await t.mutation(api.mcp_servers.create, { name: "local", projectId, threadId, transport: { args: [], command: "bun", kind: "stdio" } });
  await t.mutation(api.mcp_servers.update, { enabled: false, name: "renamed", serverId, transport: { kind: "http", url: "https://new.example.test" } });
  expect(await t.query(api.mcp_servers.listForProject, { projectId })).toMatchObject([{ enabled: false, name: "renamed", transport: { kind: "http" } }]);
  await t.mutation(api.mcp_servers.remove, { serverId });
  expect(await t.query(api.mcp_servers.listForProject, { projectId })).toEqual([]);
});

test("keeps MCP config across model changes and removes it with its approval thread", async () => {
  const t = convexTest(schema, modules);
  const { projectId, threadId } = await seed(t);
  await t.mutation(api.mcp_servers.create, { name: "docs", projectId, threadId, transport: { kind: "http", url: "https://mcp.example.test" } });
  await t.mutation(api.conversations.updateModelSelection, { modelId: "deepseek/deepseek-chat", thinkingLevel: "none", threadId });
  expect(await t.query(api.mcp_servers.listForProject, { projectId })).toHaveLength(1);
  await t.mutation(api.conversations.removeThread, { threadId });
  expect(await t.query(api.mcp_servers.listForProject, { projectId })).toEqual([]);
});
