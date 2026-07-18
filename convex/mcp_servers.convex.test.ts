import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import { digestSecret } from "./auth_helpers";
import schema from "./schema";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

async function seed(t: ReturnType<typeof convexTest>) {
  const fixture = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId: fixture.projectId, status: "idle", title: "MCP setup" }));
  return { ...fixture, threadId };
}

test("creates secret-free MCP server config and lists it for its project", async () => {
  const t = convexTest(schema, modules);
  const { owner, projectId, threadId } = await seed(t);
  const serverId = await owner.mutation(api.mcp_servers.create, { name: "docs", projectId, threadId, transport: { authEnvVar: "DOCS_TOKEN", kind: "http", url: "https://mcp.example.test" } });
  const servers = await owner.query(api.mcp_servers.listForProject, { projectId });
  expect(servers).toMatchObject([{ _id: serverId, enabled: true, name: "docs", status: "disconnected", transport: { authEnvVar: "DOCS_TOKEN", kind: "http" } }]);
  expect(JSON.stringify(servers)).not.toContain("secret-value");
});

test("allows only the owning daemon to report connection status", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId, threadId, userId } = await seed(t);
  const serverId = await owner.mutation(api.mcp_servers.create, { name: "local", projectId, threadId, transport: { args: ["server.ts"], command: "bun", kind: "stdio" } });
  const otherDeviceToken = `${"e".repeat(31)}2`;
  const otherDeviceTokenHash = await digestSecret(otherDeviceToken);
  await t.run((ctx) => ctx.db.insert("machines", { daemonVersion: "test", deviceTokenHash: otherDeviceTokenHash, lastHeartbeatAt: Date.now(), name: "other-machine", ownerId: userId, platform: "linux" }));
  await expect(t.mutation(api.mcp_servers.reportStatus, { deviceToken: otherDeviceToken, error: "no", serverId, status: "error", toolCount: 0 })).rejects.toThrow("does not own");
  await t.mutation(api.mcp_servers.reportStatus, { deviceToken, serverId, status: "connected", toolCount: 2 });
  expect(await t.query(api.mcp_servers.listForDaemon, { deviceToken })).toMatchObject([{ _id: serverId, status: "connected", toolCount: 2 }]);
});

test("updates and deletes MCP server configuration", async () => {
  const t = convexTest(schema, modules);
  const { owner, projectId, threadId } = await seed(t);
  const serverId = await owner.mutation(api.mcp_servers.create, { name: "local", projectId, threadId, transport: { args: [], command: "bun", kind: "stdio" } });
  await owner.mutation(api.mcp_servers.update, { enabled: false, name: "renamed", serverId, transport: { kind: "http", url: "https://new.example.test" } });
  expect(await owner.query(api.mcp_servers.listForProject, { projectId })).toMatchObject([{ enabled: false, name: "renamed", transport: { kind: "http" } }]);
  await owner.mutation(api.mcp_servers.remove, { serverId });
  expect(await owner.query(api.mcp_servers.listForProject, { projectId })).toEqual([]);
});

test("keeps MCP config across model changes and removes it with its approval thread", async () => {
  const t = convexTest(schema, modules);
  const { owner, projectId, threadId } = await seed(t);
  await owner.mutation(api.mcp_servers.create, { name: "docs", projectId, threadId, transport: { kind: "http", url: "https://mcp.example.test" } });
  await owner.mutation(api.conversations.updateModelSelection, { modelId: "deepseek/deepseek-v4-flash", thinkingLevel: "none", threadId });
  expect(await owner.query(api.mcp_servers.listForProject, { projectId })).toHaveLength(1);
  await owner.mutation(api.conversations.removeThread, { threadId });
  expect(await owner.query(api.mcp_servers.listForProject, { projectId })).toEqual([]);
});
