import { expect, test } from "bun:test";

import { modelCatalogSchema, resolveCatalogModel, resolveThinkingValue } from "./model-catalog";

const catalog = modelCatalogSchema.parse({
  defaultModelId: "anthropic/claude",
  models: [
    { apiKind: "anthropic-messages", cost: { input: 3, output: 15 }, fallbacks: ["openai/gpt", "deepseek/chat"], id: "anthropic/claude", name: "Claude", provider: "anthropic", thinking: { high: "16384", low: "1024", medium: "4096", none: null } },
    { apiKind: "openai-responses", cost: { input: 1, output: 4 }, fallbacks: ["deepseek/chat"], id: "openai/gpt", name: "GPT", provider: "openai", thinking: { high: "high", low: "low", medium: "medium", none: null } },
    { apiKind: "openai-completions", cost: { input: 0.2, output: 0.8 }, fallbacks: [], id: "deepseek/chat", name: "DeepSeek", provider: "deepseek", thinking: { none: null } },
  ],
});

test("resolves models in declared fallback order", () => {
  expect(resolveCatalogModel({ availableProviders: new Set(["deepseek"]), catalog, requestedModelId: "anthropic/claude" }).id).toBe("deepseek/chat");
  expect(resolveCatalogModel({ availableProviders: new Set(["openai", "deepseek"]), catalog, requestedModelId: "anthropic/claude" }).id).toBe("openai/gpt");
});

test("falls back from an unknown model through the default route", () => {
  expect(resolveCatalogModel({ availableProviders: new Set(["deepseek"]), catalog, requestedModelId: "missing/model" }).id).toBe("deepseek/chat");
});

test("maps UI thinking levels to provider request values", () => {
  expect(resolveThinkingValue({ model: catalog.models[0]!, thinkingLevel: "high" })).toBe("16384");
  expect(resolveThinkingValue({ model: catalog.models[2]!, thinkingLevel: "high" })).toBeNull();
});

test("the shared catalog contains no daemon secret metadata", async () => {
  const { MODEL_CATALOG } = await import("./model-catalog");
  const serialized = JSON.stringify(MODEL_CATALOG);
  expect(serialized).not.toContain("RELAY_");
  expect(serialized).not.toContain("API_KEY");
});

test("rejects duplicate and provider-mismatched model IDs", () => {
  const model = { apiKind: "openai-responses", cost: { input: 1, output: 1 }, fallbacks: [], id: "openai/gpt", name: "GPT", provider: "openai", thinking: { none: null } };
  expect(() => modelCatalogSchema.parse({ defaultModelId: model.id, models: [model, model] })).toThrow("Duplicate model ID");
  expect(() => modelCatalogSchema.parse({ defaultModelId: "other/gpt", models: [{ ...model, id: "other/gpt" }] })).toThrow("must start with provider");
});
