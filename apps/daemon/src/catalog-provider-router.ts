import { MODEL_CATALOG, type ModelCatalog, type ThinkingLevel } from "@relay/shared";

import { CatalogModelProvider, type ModelProvider, type ModelProviderRouter } from "./model-provider";
import { resolveProviderConfig } from "./model-router";

export class LocalModelRouter implements ModelProviderRouter {
  readonly kind: "model-router" = "model-router";
  readonly #catalog: ModelCatalog;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #fallbackProvider: ModelProvider;

  constructor({ catalog = MODEL_CATALOG, env, fallbackProvider }: { catalog?: ModelCatalog; env: Readonly<Record<string, string | undefined>>; fallbackProvider: ModelProvider }) {
    this.#catalog = catalog;
    this.#env = env;
    this.#fallbackProvider = fallbackProvider;
  }

  resolve({ modelId, thinkingLevel }: { modelId: string; thinkingLevel: ThinkingLevel }): ModelProvider {
    try {
      const config = resolveProviderConfig({ catalog: this.#catalog, env: this.#env, modelId, thinkingLevel });
      return new CatalogModelProvider(config);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("No configured provider")) return this.#fallbackProvider;
      throw error;
    }
  }
}
