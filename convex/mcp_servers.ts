import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const transport = v.union(
  v.object({ authEnvVar: v.optional(v.string()), kind: v.literal("http"), oauthIssuer: v.optional(v.string()), url: v.string() }),
  v.object({ args: v.array(v.string()), command: v.string(), cwd: v.optional(v.string()), envVarNames: v.optional(v.array(v.string())), kind: v.literal("stdio") }),
);
const status = v.union(v.literal("disconnected"), v.literal("connecting"), v.literal("authorizing"), v.literal("connected"), v.literal("error"));

export const create = mutationGeneric({
  args: { name: v.string(), projectId: v.id("projects"), threadId: v.id("threads"), transport },
  handler: async (ctx, args) => {
    validateServerInput(args.name, args.transport);
    if (!(await ctx.db.get("projects", args.projectId))) throw new Error("MCP project not found");
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread || thread.projectId !== args.projectId) throw new Error("MCP approval thread must belong to project");
    return ctx.db.insert("mcpServers", { approvalThreadId: args.threadId, enabled: true, name: args.name, projectId: args.projectId, status: "disconnected", transport: args.transport });
  },
});

export const update = mutationGeneric({
  args: { enabled: v.boolean(), name: v.string(), serverId: v.id("mcpServers"), transport },
  handler: async (ctx, args) => {
    validateServerInput(args.name, args.transport);
    const server = await ctx.db.get("mcpServers", args.serverId);
    if (!server) throw new Error("MCP server not found");
    await ctx.db.patch(server._id, { authorizationUrl: undefined, enabled: args.enabled, error: undefined, name: args.name, status: "disconnected", toolCount: undefined, transport: args.transport });
  },
});

function validateServerInput(name: string, value: { kind: "http"; url: string; authEnvVar?: string; oauthIssuer?: string } | { kind: "stdio"; command: string; args: string[]; cwd?: string; envVarNames?: string[] }): void {
  if (!name.trim() || name.length > 80) throw new Error("Invalid MCP server name");
  const envPattern = /^[A-Z_][A-Z0-9_]*$/;
  if (value.kind === "http") {
    const url = new URL(value.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) throw new Error("MCP HTTP URL must use HTTPS or loopback HTTP");
    if (value.authEnvVar && !envPattern.test(value.authEnvVar)) throw new Error("Invalid MCP token environment variable");
    if (value.oauthIssuer) {
      const issuer = new URL(value.oauthIssuer);
      if (issuer.protocol !== "https:" && !(issuer.protocol === "http:" && (issuer.hostname === "127.0.0.1" || issuer.hostname === "localhost"))) throw new Error("MCP OAuth issuer must use HTTPS or loopback HTTP");
    }
    if (value.authEnvVar && value.oauthIssuer) throw new Error("Choose either OAuth or an environment token");
    return;
  }
  if (!value.command || value.command.length > 4096 || value.args.length > 100) throw new Error("Invalid MCP stdio command");
  if (value.args.some((argument) => /(?:^|[-_])(?:api[-_]?key|password|secret|token)(?:=|$)/i.test(argument))) throw new Error("Store stdio credentials in allowed environment variables");
  for (const envName of value.envVarNames ?? []) if (!envPattern.test(envName)) throw new Error("Invalid MCP stdio environment variable");
}

export const remove = mutationGeneric({
  args: { serverId: v.id("mcpServers") },
  handler: async (ctx, args) => {
    const server = await ctx.db.get("mcpServers", args.serverId);
    if (!server) throw new Error("MCP server not found");
    await ctx.db.delete(server._id);
  },
});

export const listForProject = queryGeneric({
  args: { projectId: v.id("projects") },
  handler: (ctx, args) => ctx.db.query("mcpServers").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).take(100),
});

export const listForDaemon = queryGeneric({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    if (!machine) throw new Error("Unknown development device token");
    const projects = await ctx.db.query("projects").withIndex("by_machine", (q) => q.eq("machineId", machine._id)).take(100);
    const nested = await Promise.all(projects.map((project) => ctx.db.query("mcpServers").withIndex("by_project", (q) => q.eq("projectId", project._id)).take(100)));
    return nested.flat();
  },
});

export const reportStatus = mutationGeneric({
  args: { authorizationUrl: v.optional(v.string()), deviceToken: v.string(), error: v.optional(v.string()), serverId: v.id("mcpServers"), status, toolCount: v.number() },
  handler: async (ctx, args) => {
    const server = await ctx.db.get("mcpServers", args.serverId);
    if (!server) throw new Error("MCP server not found");
    const project = await ctx.db.get("projects", server.projectId);
    const machine = project ? await ctx.db.get("machines", project.machineId) : null;
    if (!machine || machine.deviceToken !== args.deviceToken) throw new Error("Daemon does not own MCP server");
    await ctx.db.patch(server._id, { authorizationUrl: args.authorizationUrl, error: args.error, status: args.status, toolCount: args.toolCount });
  },
});
