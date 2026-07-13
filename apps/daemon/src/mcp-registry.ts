import { mcpServerConfigSchema, type McpServerConfig } from "@relay/shared";
import type { McpModelTool } from "./model-provider";
import { McpClient, StdioTransport, StreamableHttpTransport, type McpTransport } from "./mcp-client";
import type { GovernanceGateway } from "./governed-tool-executor";
import { FileOAuthTokenStore, McpOAuthClient, OAuthAuthorizationRequiredError, type OAuthTokenStore } from "./mcp-oauth";
import { homedir } from "node:os";
import { join } from "node:path";

export type McpServerRecord = McpServerConfig & { _id: string; approvalThreadId: string };
export interface McpServerGateway {
  listServers(): Promise<unknown[]>;
  reportStatus(input: { authorizationUrl?: string; error?: string; serverId: string; status: "connecting" | "authorizing" | "connected" | "error"; toolCount: number }): Promise<unknown>;
}

export class McpRegistry {
  readonly #clients = new Map<string, { client: McpClient; config: McpServerRecord; signature: string; transport: McpTransport }>();
  readonly #decisions = new Map<string, { allowed: boolean; signature: string }>();
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #createTransport: (input: { config: McpServerRecord; env: Readonly<Record<string, string | undefined>>; oauthStore: OAuthTokenStore }) => McpTransport | Promise<McpTransport>;
  readonly #gateway: McpServerGateway;
  readonly #governance: GovernanceGateway;
  readonly #oauthStore: OAuthTokenStore;
  readonly #oauthPending = new Set<string>();

  constructor({ createTransport: transportFactory = createTransport, env, gateway, governance, oauthStore = new FileOAuthTokenStore({ path: join(env.RELAY_DAEMON_HOME ?? join(homedir(), ".relay"), "mcp-oauth.json") }) }: { createTransport?: (input: { config: McpServerRecord; env: Readonly<Record<string, string | undefined>>; oauthStore: OAuthTokenStore }) => McpTransport | Promise<McpTransport>; env: Readonly<Record<string, string | undefined>>; gateway: McpServerGateway; governance: GovernanceGateway; oauthStore?: OAuthTokenStore }) {
    this.#createTransport = transportFactory;
    this.#env = env;
    this.#gateway = gateway;
    this.#governance = governance;
    this.#oauthStore = oauthStore;
  }

  async listTools(): Promise<McpModelTool[]> {
    const servers = await this.#sync();
    const tools: McpModelTool[] = [];
    for (const server of servers) {
      try {
        if (this.#oauthPending.has(server._id)) continue;
        await this.#gateway.reportStatus({ serverId: server._id, status: "connecting", toolCount: 0 });
        const entry = this.#clients.get(server._id);
        if (!entry) {
          const decision = this.#decisions.get(server._id);
          await this.#gateway.reportStatus({ error: decision?.allowed ? "MCP connection setup failed. Check daemon logs." : "MCP connection was not approved.", serverId: server._id, status: "error", toolCount: 0 });
          continue;
        }
        const discovered = await entry.client.listTools();
        tools.push(...discovered.map((tool) => ({ description: tool.description, inputSchema: tool.inputSchema, name: tool.name, risk: "high" as const, serverId: server._id })));
        await this.#gateway.reportStatus({ serverId: server._id, status: "connected", toolCount: discovered.length });
      } catch (error) {
        console.error(`MCP server ${server._id} failed: ${redactLocalError(error, this.#env)}`);
        await this.#gateway.reportStatus({ error: "MCP connection failed. Check daemon logs.", serverId: server._id, status: "error", toolCount: 0 });
      }
    }
    return tools;
  }

  async callTool(input: { arguments: Record<string, unknown>; name: string; onInputRequired?: (input: { prompts: unknown[] }) => Promise<Record<string, unknown>>; onTaskStatus?: (task: { id: string; status: string }) => Promise<void> | void; serverId: string }): Promise<unknown> {
    const entry = this.#clients.get(input.serverId);
    if (!entry) throw new Error("MCP server is not connected");
    return entry.client.callTool({
      ...input,
      onInputRequired: input.onInputRequired ? async ({ prompts }) => input.onInputRequired!({ prompts: redactCloudPrompts(prompts, await this.#cloudSecrets(entry.config)) }) : undefined,
      onTaskStatus: input.onTaskStatus ? async (task) => input.onTaskStatus!({ ...task, id: redactCloudText(task.id, await this.#cloudSecrets(entry.config)) }) : undefined,
    });
  }

  async #cloudSecrets(config: McpServerRecord): Promise<string[]> {
    const secrets = Object.values(this.#env).filter((value): value is string => typeof value === "string" && value.length >= 4);
    if (config.transport.kind === "http" && config.transport.oauthIssuer) {
      const token = await this.#oauthStore.load(normalizeIssuer(config.transport.oauthIssuer));
      if (token) secrets.push(token.accessToken, token.refreshToken, ...(token.clientSecret ? [token.clientSecret] : []));
    }
    return secrets;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#clients.values()].map(({ transport }) => transport.close?.()));
    this.#clients.clear();
  }

  async #sync(): Promise<McpServerRecord[]> {
    const rawServers = await this.#gateway.listServers();
    const servers: McpServerRecord[] = [];
    for (const rawServer of rawServers) {
      try {
        const server = parseServer(rawServer);
        if (server.enabled) servers.push(server);
      } catch (error) {
        const serverId = recordId(rawServer);
        console.error(`Invalid MCP server configuration${serverId ? ` ${serverId}` : ""}: ${redactLocalError(error, this.#env)}`);
        if (serverId) await this.#gateway.reportStatus({ error: "Invalid MCP server configuration.", serverId, status: "error", toolCount: 0 });
      }
    }
    const activeIds = new Set(servers.map((server) => server._id));
    for (const [id, entry] of this.#clients) if (!activeIds.has(id)) {
      await entry.transport.close?.();
      this.#clients.delete(id);
      this.#decisions.delete(id);
    }
    for (const server of servers) {
      const signature = JSON.stringify(server.transport);
      const existing = this.#clients.get(server._id);
      if (existing?.signature === signature) continue;
      await existing?.transport.close?.();
      this.#clients.delete(server._id);
      try {
        const priorDecision = this.#decisions.get(server._id);
        let allowed = priorDecision?.signature === signature ? priorDecision.allowed : false;
        if (priorDecision?.signature !== signature) {
          allowed = await this.#governance.requestApproval({ capability: "exec", risk: server.transport.kind === "stdio" ? "critical" : "high", summary: summarizeConnection(server), threadId: server.approvalThreadId }) === "allow";
          this.#decisions.set(server._id, { allowed, signature });
        }
        if (!allowed) continue;
        const transport = await this.#createTransport({ config: server, env: this.#env, oauthStore: this.#oauthStore });
        this.#clients.set(server._id, { client: new McpClient({ serverId: server._id, transport }), config: server, signature, transport });
      } catch (error) {
        if (error instanceof OAuthAuthorizationRequiredError && server.transport.kind === "http" && server.transport.oauthIssuer) {
          await this.#beginOAuth({ issuer: server.transport.oauthIssuer, serverId: server._id });
          continue;
        }
        console.error(`MCP server ${server._id} setup failed: ${redactLocalError(error, this.#env)}`);
        await this.#gateway.reportStatus({ error: "MCP connection setup failed. Check daemon logs.", serverId: server._id, status: "error", toolCount: 0 });
      }
    }
    return servers;
  }

  async #beginOAuth({ issuer, serverId }: { issuer: string; serverId: string }): Promise<void> {
    if (this.#oauthPending.has(serverId)) return;
    this.#oauthPending.add(serverId);
    try {
      const flow = await new McpOAuthClient({ issuer, redirectUri: "http://127.0.0.1:43119/callback", store: this.#oauthStore }).beginAuthorization();
      await this.#gateway.reportStatus({ authorizationUrl: flow.authorizationUrl, serverId, status: "authorizing", toolCount: 0 });
      void flow.completion.then(
        () => this.#gateway.reportStatus({ serverId, status: "connecting", toolCount: 0 }),
        (error: unknown) => this.#gateway.reportStatus({ error: `MCP OAuth failed: ${redactLocalError(error, this.#env)}`, serverId, status: "error", toolCount: 0 }),
      ).finally(() => { this.#oauthPending.delete(serverId); });
    } catch (error) {
      this.#oauthPending.delete(serverId);
      await this.#gateway.reportStatus({ error: "MCP OAuth setup failed. Check daemon logs.", serverId, status: "error", toolCount: 0 });
    }
  }
}

function recordId(value: unknown): string | null {
  return typeof value === "object" && value !== null && "_id" in value && typeof value._id === "string" ? value._id : null;
}

function parseServer(value: unknown): McpServerRecord {
  if (typeof value !== "object" || value === null || !("_id" in value) || typeof value._id !== "string" || !("approvalThreadId" in value) || typeof value.approvalThreadId !== "string") throw new Error("Invalid MCP server record");
  const source = value as Record<string, unknown>;
  return { _id: value._id, approvalThreadId: value.approvalThreadId, ...mcpServerConfigSchema.parse({ enabled: source.enabled, name: source.name, transport: source.transport }) };
}

async function createTransport({ config, env, oauthStore }: { config: McpServerRecord; env: Readonly<Record<string, string | undefined>>; oauthStore: OAuthTokenStore }): Promise<McpTransport> {
  if (config.transport.kind === "http") {
    if (config.transport.oauthIssuer) {
      const oauth = new McpOAuthClient({ issuer: config.transport.oauthIssuer, redirectUri: "http://127.0.0.1:43119/callback", store: oauthStore });
      await oauth.accessToken();
      return new StreamableHttpTransport({ authTokenProvider: () => oauth.accessToken(), url: config.transport.url });
    }
    return new StreamableHttpTransport({ authToken: config.transport.authEnvVar ? env[config.transport.authEnvVar] : undefined, url: config.transport.url });
  }
  const selectedEnv: Record<string, string> = {};
  if (env.PATH) selectedEnv.PATH = env.PATH;
  for (const name of config.transport.envVarNames ?? []) if (env[name] !== undefined) selectedEnv[name] = env[name];
  return new StdioTransport({ args: config.transport.args, command: config.transport.command, cwd: config.transport.cwd, env: selectedEnv });
}

function redactLocalError(error: unknown, env: Readonly<Record<string, string | undefined>>): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of Object.values(env)) if (value && value.length >= 4) message = message.replaceAll(value, "[REDACTED]");
  return message.replaceAll(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500);
}

function redactCloudText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) if (secret.length >= 4) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted.slice(0, 10_000);
}

function redactCloudValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 16) return "[TRUNCATED]";
  if (typeof value === "string") return redactCloudText(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactCloudValue(item, secrets, depth + 1));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [redactCloudText(key, secrets), redactCloudValue(item, secrets, depth + 1)]));
  return value;
}

function redactCloudPrompts(prompts: unknown[], secrets: readonly string[]): unknown[] {
  return prompts.slice(0, 100).map((prompt) => redactCloudValue(prompt, secrets));
}

function normalizeIssuer(value: string): string { return new URL(value).toString().replace(/\/$/, ""); }

function summarizeConnection(server: McpServerRecord): string {
  if (server.transport.kind === "http") return `Connect MCP server ${server.name}: ${server.transport.url}`;
  return `Connect MCP server ${server.name}: ${[server.transport.command, ...server.transport.args].join(" ")}`.slice(0, 500);
}
