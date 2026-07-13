import { expect, test } from "bun:test";

import { MODEL_CATALOG } from "@relay/shared";
import { buildProviderRequest, buildProviderToolRequest, resolveProviderConfig } from "./model-router";
import { LocalModelRouter } from "./catalog-provider-router";
import { ScriptedModelProvider } from "./model-provider";

test("routes to the first fallback with a locally configured secret", () => {
  const config = resolveProviderConfig({
    catalog: MODEL_CATALOG,
    env: { RELAY_DEEPSEEK_API_KEY: "local-deepseek-key" },
    modelId: "anthropic/claude-sonnet-4-5",
    thinkingLevel: "high",
  });
  expect(config.model.id).toBe("deepseek/deepseek-chat");
  expect(config.apiKey).toBe("local-deepseek-key");
});

test("builds Anthropic Messages requests with mapped thinking budgets", () => {
  const model = MODEL_CATALOG.models.find((entry) => entry.apiKind === "anthropic-messages")!;
  const request = buildProviderRequest({ apiKey: "secret", model, prompt: "hello", thinkingValue: "4096" });
  expect(request.url).toBe("https://api.anthropic.com/v1/messages");
  expect(request.headers["x-api-key"]).toBe("secret");
  expect(request.body).toMatchObject({ model: "claude-sonnet-4-5", thinking: { budget_tokens: 4096, type: "enabled" } });
});

test("builds OpenAI Responses and compatible Completions requests", () => {
  const responsesModel = MODEL_CATALOG.models.find((entry) => entry.apiKind === "openai-responses")!;
  const responses = buildProviderRequest({ apiKey: "secret", model: responsesModel, prompt: "hello", thinkingValue: "high" });
  expect(responses.url).toBe("https://api.openai.com/v1/responses");
  expect(responses.body).toMatchObject({ model: "gpt-5-mini", reasoning: { effort: "high" } });

  const completionsModel = MODEL_CATALOG.models.find((entry) => entry.apiKind === "openai-completions")!;
  const completions = buildProviderRequest({ apiKey: "secret", model: completionsModel, prompt: "hello", thinkingValue: null });
  expect(completions.url).toBe("https://api.deepseek.com/chat/completions");
  expect(completions.body).toMatchObject({ model: "deepseek-chat" });
  expect(JSON.stringify(completions.body)).not.toContain("secret");
});

test("uses the scripted development provider when no local key is configured", () => {
  const fallback = new ScriptedModelProvider({ chunks: ["offline"] });
  const router = new LocalModelRouter({ env: {}, fallbackProvider: fallback });
  expect(router.resolve({ modelId: MODEL_CATALOG.defaultModelId, thinkingLevel: "none" })).toBe(fallback);
});

test("adds uniquely-addressed MCP schemas to provider tool definitions", () => {
  const model = MODEL_CATALOG.models.find((entry) => entry.apiKind === "openai-completions")!;
  const request = buildProviderToolRequest({ apiKey: "secret", mcpTools: [
    { inputSchema: { type: "object" }, name: "same", risk: "low", serverId: "a" },
    { inputSchema: { properties: { value: { type: "string" } }, type: "object" }, name: "same", risk: "high", serverId: "b" },
  ], model, prompt: "use tools", thinkingValue: null });
  const names = (request.body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  expect(names.slice(-2)).toEqual(["mcp_0", "mcp_1"]);
});
