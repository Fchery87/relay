import { resolveCatalogModel, resolveThinkingValue, type CatalogModel, type ModelCatalog, type ThinkingLevel } from "@relay/shared";
import type { McpModelTool } from "./model-provider";

type ProviderSecrets = Readonly<Record<string, string>>;

export type ProviderConfig = { apiKey: string; model: CatalogModel; thinkingValue: string | null };
export type ProviderRequest = { body: Record<string, unknown>; headers: Record<string, string>; url: string };

export const TOOL_PARAMETERS = {
  bash: { properties: { command: { type: "string" } }, required: ["command"], type: "object" },
  edit: { properties: { content: { type: "string" }, path: { type: "string" } }, required: ["path", "content"], type: "object" },
  read: { properties: { path: { type: "string" } }, required: ["path"], type: "object" },
  task: { properties: { capabilities: { items: { enum: ["read", "edit", "exec", "task"], type: "string" }, type: "array" }, role: { type: "string" }, task: { type: "string" } }, required: ["role", "task", "capabilities"], type: "object" },
  web_search: { properties: { query: { description: "Search query to look up on the web", type: "string" } }, required: ["query"], type: "object" },
  web_fetch: { properties: { url: { description: "URL to fetch content from", type: "string" }, prompt: { description: "What to extract from the page", type: "string" } }, required: ["url", "prompt"], type: "object" },
} as const;

export function mcpModelName(_tool: Pick<McpModelTool, "name" | "serverId">, index = 0): string {
  return `mcp_${index}`;
}

export function readProviderSecrets(env: Readonly<Record<string, string | undefined>>): ProviderSecrets {
  const secrets: Record<string, string> = {};
  if (env.RELAY_ANTHROPIC_API_KEY) secrets.anthropic = env.RELAY_ANTHROPIC_API_KEY;
  if (env.RELAY_DEEPSEEK_API_KEY) secrets.deepseek = env.RELAY_DEEPSEEK_API_KEY;
  if (env.RELAY_OPENAI_API_KEY) secrets.openai = env.RELAY_OPENAI_API_KEY;
  return secrets;
}

export function resolveProviderConfig({ catalog, env, modelId, thinkingLevel }: {
  catalog: ModelCatalog;
  env: Readonly<Record<string, string | undefined>>;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}): ProviderConfig {
  const secrets = readProviderSecrets(env);
  const model = resolveCatalogModel({ availableProviders: new Set(Object.keys(secrets)), catalog, requestedModelId: modelId });
  const apiKey = secrets[model.provider];
  if (!apiKey) throw new Error(`No API key configured for ${model.provider}`);
  return { apiKey, model, thinkingValue: resolveThinkingValue({ model, thinkingLevel }) };
}

export function buildProviderRequest({ apiKey, model, prompt, thinkingValue }: { apiKey: string; model: CatalogModel; prompt: string; thinkingValue: string | null }): ProviderRequest {
  const providerModelId = model.id.slice(model.provider.length + 1);
  if (model.apiKind === "anthropic-messages") {
    const budget = thinkingValue === null ? undefined : Number(thinkingValue);
    return {
      body: {
        max_tokens: budget === undefined ? 4096 : Math.max(4096, budget + 1024),
        messages: [{ content: prompt, role: "user" }],
        model: providerModelId,
        stream: true,
        ...(budget === undefined ? {} : { thinking: { budget_tokens: budget, type: "enabled" } }),
      },
      headers: { "anthropic-version": "2023-06-01", "content-type": "application/json", "x-api-key": apiKey },
      url: "https://api.anthropic.com/v1/messages",
    };
  }
  if (model.apiKind === "openai-responses") {
    return {
      body: { input: prompt, model: providerModelId, stream: true, ...(thinkingValue === null ? {} : { reasoning: { effort: thinkingValue } }) },
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      url: "https://api.openai.com/v1/responses",
    };
  }
  return {
    body: {
      messages: [{ content: prompt, role: "user" }],
      model: providerModelId,
      stream: true,
      stream_options: { include_usage: true },
      ...(model.provider === "deepseek"
        ? (thinkingValue === null ? { thinking: { type: "disabled" } } : { reasoning_effort: thinkingValue })
        : (thinkingValue === null ? {} : { reasoning_effort: thinkingValue })),
    },
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    url: model.provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions",
  };
}

export function buildProviderToolRequest(input: { apiKey: string; mcpTools?: McpModelTool[]; model: CatalogModel; prompt: string; thinkingValue: string | null }): ProviderRequest {
  const request = buildProviderRequest(input);
  const definitions = [
    ...Object.entries(TOOL_PARAMETERS).map(([name, parameters]) => ({ description: `Relay ${name} tool`, name, parameters })),
    ...(input.mcpTools ?? []).map((tool, index) => ({ description: tool.description ?? `MCP ${tool.serverId}/${tool.name}`, name: mcpModelName(tool, index), parameters: tool.inputSchema })),
  ];
  if (input.model.apiKind === "anthropic-messages") return { ...request, body: { ...request.body, stream: false, tools: definitions.map(({ description, name, parameters }) => ({ description, input_schema: parameters, name })) } };
  if (input.model.apiKind === "openai-responses") return { ...request, body: { ...request.body, stream: false, tools: definitions.map(({ description, name, parameters }) => ({ description, name, parameters, strict: true, type: "function" })) } };
  return { ...request, body: { ...request.body, stream: false, stream_options: undefined, tools: definitions.map(({ description, name, parameters }) => ({ function: { description, name, parameters }, type: "function" })) } };
}
