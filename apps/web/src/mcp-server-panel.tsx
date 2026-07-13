import { useState, type FormEvent } from "react";
import type { McpServerConfig } from "@relay/shared";

export type McpServer = McpServerConfig & { _id: string; authorizationUrl?: string; error?: string; status: "disconnected" | "connecting" | "authorizing" | "connected" | "error"; toolCount?: number };
type ServerInput = Pick<McpServerConfig, "name" | "transport">;

export function McpServerPanel({ onCreate, onRemove, onUpdate, servers }: {
  onCreate(input: ServerInput): Promise<unknown> | unknown;
  onRemove(serverId: string): Promise<unknown> | unknown;
  onUpdate(input: McpServerConfig & { serverId: string }): Promise<unknown> | unknown;
  servers: McpServer[];
}) {
  const [adding, setAdding] = useState(false);
  return <section className="mcp-panel">
    <header><h2>MCP servers</h2><button aria-label="Add MCP server" onClick={() => setAdding((value) => !value)} type="button">Add server</button></header>
    {adding ? <ServerForm onCancel={() => setAdding(false)} onSubmit={async (input) => { await onCreate(input); setAdding(false); }} /> : null}
    <div className="mcp-server-list">{servers.map((server) => <ServerEditor key={server._id} onRemove={onRemove} onUpdate={onUpdate} server={server} />)}</div>
    {servers.length === 0 && !adding ? <p className="mcp-empty">No MCP servers configured.</p> : null}
  </section>;
}

function ServerEditor({ onRemove, onUpdate, server }: { onRemove(serverId: string): unknown; onUpdate(input: McpServerConfig & { serverId: string }): unknown; server: McpServer }) {
  return <details className="mcp-server">
    <summary><span><strong>{server.name}</strong><small>{statusLabel(server)}</small></span><i className={`mcp-status mcp-status-${server.status}`} aria-label={server.status} /></summary>
    {server.error ? <p className="mcp-error">{server.error}</p> : null}
    {server.authorizationUrl ? <a className="mcp-authorize" href={server.authorizationUrl} rel="noreferrer" target="_blank">Authorize OAuth</a> : null}
    <ServerForm initial={server} onCancel={() => undefined} onSubmit={(input) => onUpdate({ ...input, enabled: server.enabled, serverId: server._id })} submitLabel="Save" />
    <div className="mcp-server-actions"><label><input checked={server.enabled} onChange={(event) => void onUpdate({ enabled: event.target.checked, name: server.name, serverId: server._id, transport: server.transport })} type="checkbox" /> Enabled</label><button onClick={() => void onRemove(server._id)} type="button">Remove</button></div>
  </details>;
}

function ServerForm({ initial, onCancel, onSubmit, submitLabel = "Add" }: { initial?: McpServer; onCancel(): void; onSubmit(input: ServerInput): Promise<unknown> | unknown; submitLabel?: string }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<"http" | "stdio">(initial?.transport.kind ?? "http");
  const [endpoint, setEndpoint] = useState(initial?.transport.kind === "http" ? initial.transport.url : initial?.transport.command ?? "");
  const [args, setArgs] = useState(initial?.transport.kind === "stdio" ? initial.transport.args.join(" ") : "");
  const [credentialEnv, setCredentialEnv] = useState(initial?.transport.kind === "http" ? initial.transport.authEnvVar ?? "" : initial?.transport.envVarNames?.join(", ") ?? "");
  const [oauthIssuer, setOauthIssuer] = useState(initial?.transport.kind === "http" ? initial.transport.oauthIssuer ?? "" : "");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !endpoint.trim()) return;
    const transport = kind === "http"
      ? { ...(credentialEnv.trim() ? { authEnvVar: credentialEnv.trim() } : {}), kind, ...(oauthIssuer.trim() ? { oauthIssuer: oauthIssuer.trim() } : {}), url: endpoint.trim() } as const
      : { args: splitArgs(args), command: endpoint.trim(), ...(credentialEnv.trim() ? { envVarNames: credentialEnv.split(",").map((value) => value.trim()).filter(Boolean) } : {}), kind } as const;
    await onSubmit({ name: name.trim(), transport });
  }
  return <form className="mcp-form" onSubmit={(event) => void submit(event)}>
    <label>Name<input aria-label="MCP server name" onChange={(event) => setName(event.target.value)} value={name} /></label>
    <label>Transport<select aria-label="MCP transport" onChange={(event) => setKind(event.target.value === "stdio" ? "stdio" : "http")} value={kind}><option value="http">Streamable HTTP</option><option value="stdio">stdio</option></select></label>
    <label>{kind === "http" ? "URL" : "Command"}<input aria-label={kind === "http" ? "MCP server URL" : "MCP server command"} onChange={(event) => setEndpoint(event.target.value)} value={endpoint} /></label>
    {kind === "stdio" ? <label>Arguments<input aria-label="MCP server arguments" onChange={(event) => setArgs(event.target.value)} value={args} /></label> : null}
    <label>{kind === "http" ? "Token environment variable" : "Allowed environment variables"}<input aria-label="MCP credential environment variable" onChange={(event) => { setCredentialEnv(event.target.value); if (kind === "http" && event.target.value) setOauthIssuer(""); }} value={credentialEnv} /></label>
    {kind === "http" ? <label>OAuth issuer<input aria-label="MCP OAuth issuer" onChange={(event) => { setOauthIssuer(event.target.value); if (event.target.value) setCredentialEnv(""); }} value={oauthIssuer} /></label> : null}
    <div className="mcp-form-actions"><button onClick={onCancel} type="button">Cancel</button><button type="submit">{submitLabel}</button></div>
  </form>;
}

function splitArgs(value: string): string[] { return value.trim() ? value.trim().split(/\s+/) : []; }
function statusLabel(server: McpServer): string {
  if (server.status === "connected") return `Connected · ${server.toolCount ?? 0} tools`;
  if (server.status === "connecting") return "Connecting";
  if (server.status === "authorizing") return "OAuth authorization required";
  if (server.status === "error") return "Connection error";
  return "Disconnected";
}
