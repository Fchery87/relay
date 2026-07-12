import { resolveCatalogModel, resolveThinkingValue, type CatalogModel, type ModelCatalog, type ThinkingLevel } from "@relay/shared";

type ProviderSecrets = Readonly<Record<string, string>>;

export type ProviderConfig = { apiKey: string; model: CatalogModel; thinkingValue: string | null };
export type ProviderRequest = { body: Record<string, unknown>; headers: Record<string, string>; url: string };

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
    body: { messages: [{ content: prompt, role: "user" }], model: providerModelId, stream: true, stream_options: { include_usage: true }, ...(thinkingValue === null ? {} : { reasoning_effort: thinkingValue }) },
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    url: model.provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions",
  };
}
