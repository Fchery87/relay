import { z } from "zod";
import modelCatalogJson from "../models.json" with { type: "json" };

export const apiKindSchema = z.enum(["anthropic-messages", "openai-responses", "openai-completions"]);
export const thinkingLevelSchema = z.enum(["none", "low", "medium", "high"]);
const thinkingMapSchema = z.object({
  none: z.string().nullable().optional(),
  low: z.string().nullable().optional(),
  medium: z.string().nullable().optional(),
  high: z.string().nullable().optional(),
});
export const catalogModelSchema = z.object({
  apiKind: apiKindSchema,
  contextWindow: z.number().positive().optional(),
  cost: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative().optional(), cacheWrite: z.number().nonnegative().optional() }),
  fallbacks: z.array(z.string().min(1)),
  id: z.string().min(1),
  maxOutputTokens: z.number().positive().optional(),
  name: z.string().min(1),
  provider: z.string().min(1),
  thinking: thinkingMapSchema,
});
export const modelCatalogSchema = z.object({
  defaultModelId: z.string().min(1),
  models: z.array(catalogModelSchema).min(1),
}).superRefine((catalog, ctx) => {
  const ids = new Set(catalog.models.map((model) => model.id));
  if (ids.size !== catalog.models.length) ctx.addIssue({ code: "custom", message: "Duplicate model ID in catalog" });
  if (!ids.has(catalog.defaultModelId)) ctx.addIssue({ code: "custom", message: "Default model is missing from the catalog" });
  for (const model of catalog.models) {
    if (!model.id.startsWith(`${model.provider}/`)) ctx.addIssue({ code: "custom", message: `Model ID ${model.id} must start with provider ${model.provider}` });
    for (const fallback of model.fallbacks) if (!ids.has(fallback)) ctx.addIssue({ code: "custom", message: `Unknown fallback ${fallback}` });
  }
});

export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const MODEL_CATALOG = modelCatalogSchema.parse(modelCatalogJson);
export const DEFAULT_MODEL_ID = MODEL_CATALOG.defaultModelId;

export function resolveCatalogModel({ availableProviders, catalog, requestedModelId }: { availableProviders: ReadonlySet<string>; catalog: ModelCatalog; requestedModelId: string }): CatalogModel {
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  const requested = byId.get(requestedModelId) ?? byId.get(catalog.defaultModelId);
  if (!requested) throw new Error("Catalog default model is missing");
  const queue = [requested];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const model = queue.shift();
    if (!model || visited.has(model.id)) continue;
    visited.add(model.id);
    if (availableProviders.has(model.provider)) return model;
    for (const fallbackId of model.fallbacks) {
      const fallback = byId.get(fallbackId);
      if (fallback) queue.push(fallback);
    }
  }
  throw new Error(`No configured provider can serve ${requestedModelId}`);
}

export function resolveThinkingValue({ model, thinkingLevel }: { model: CatalogModel; thinkingLevel: ThinkingLevel }): string | null {
  return model.thinking[thinkingLevel] ?? null;
}

export function listThinkingLevels(model: CatalogModel): ThinkingLevel[] {
  return thinkingLevelSchema.options.filter((level) => level in model.thinking);
}
