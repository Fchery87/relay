import { z } from "zod";

const envVarName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

export const mcpTransportConfigSchema = z.discriminatedUnion("kind", [
  z.object({ authEnvVar: envVarName.optional(), kind: z.literal("http"), oauthIssuer: z.url().refine(isSecureRemoteUrl, "MCP OAuth issuer must use HTTPS or loopback HTTP").optional(), url: z.url().refine(isSecureRemoteUrl, "MCP HTTP URL must use HTTPS or loopback HTTP") }).strict().refine((value) => !(value.authEnvVar && value.oauthIssuer), "Choose either OAuth or an environment token"),
  z.object({ args: z.array(z.string()).max(100).default([]), command: z.string().min(1).max(4096), cwd: z.string().min(1).max(4096).optional(), envVarNames: z.array(envVarName).max(50).optional(), kind: z.literal("stdio") }).strict().refine((value) => !value.args.some((argument) => /(?:^|[-_])(?:api[-_]?key|password|secret|token)(?:=|$)/i.test(argument)), "Store stdio credentials in allowed environment variables"),
]);

export const mcpServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  name: z.string().trim().min(1).max(80),
  transport: mcpTransportConfigSchema,
}).strict();

export const mcpRiskSchema = z.enum(["low", "high", "critical"]);
export const mcpToolSchema = z.object({
  annotations: z.object({ risk: mcpRiskSchema.optional() }).passthrough().optional(),
  description: z.string().max(10_000).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  name: z.string().min(1).max(200),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

export type McpRisk = z.infer<typeof mcpRiskSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpTool = z.infer<typeof mcpToolSchema>;

const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 2_000;

export function validateMcpToolSchema(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("MCP tool schema must be a JSON object");
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES) throw new Error("MCP tool schema exceeds node limit");
    if (depth > MAX_SCHEMA_DEPTH) throw new Error("MCP tool schema exceeds depth limit");
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (!isPlainObject(node)) return;
    if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) throw new Error("External JSON Schema references are not allowed");
    if (typeof node.pattern === "string" && (node.pattern.length > 1_000 || /\([^)]*[+*][^)]*\)[+*{]/.test(node.pattern))) throw new Error("MCP tool schema contains an unsafe regular expression");
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  visit(value, 0);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isSecureRemoteUrl(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"));
}
