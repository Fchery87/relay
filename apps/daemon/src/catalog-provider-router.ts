import { MODEL_CATALOG, type ModelCatalog, type ThinkingLevel } from "@relay/shared";

import { CatalogModelProvider, type ModelProvider, type ModelProviderRouter, resolveTurnProvider } from "./model-provider";
import type { ChatMessage, TurnModelProvider, TurnStreamEvent } from "./turn-loop";
import { resolveProviderConfig } from "./model-router";

export class LocalModelRouter implements ModelProviderRouter {
  readonly kind: "model-router" = "model-router";
  readonly #catalog: ModelCatalog;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #fallbackProvider: ModelProvider;
  #fallbackActivations = 0;

  get fallbackActivations(): number { return this.#fallbackActivations; }

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
      if (error instanceof Error && error.message.startsWith("No configured provider")) {
        this.#fallbackActivations++;
        return this.#fallbackProvider;
      }
      throw error;
    }
  }

  resolveTurn({ modelId, thinkingLevel }: { modelId: string; thinkingLevel: ThinkingLevel }): TurnModelProvider {
    try {
      const config = resolveProviderConfig({ catalog: this.#catalog, env: this.#env, modelId, thinkingLevel });
      return resolveTurnProvider(config);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("No configured provider")) {
        this.#fallbackActivations++;
        return asTurnProvider(this.#fallbackProvider);
      }
      throw error;
    }
  }
}

function isTurnModelProvider(value: ModelProvider): value is ModelProvider & TurnModelProvider {
  return "streamTurn" in value && typeof value.streamTurn === "function";
}

/** Adapt the legacy one-shot provider only at the kernel router boundary. */
function asTurnProvider(value: ModelProvider): TurnModelProvider {
  if (isTurnModelProvider(value)) return value;
  return {
    modelId: value.modelId,
    async *streamTurn({ messages, signal }: { messages: ChatMessage[]; signal: AbortSignal; system: string; tools: never[] }): AsyncIterable<TurnStreamEvent> {
      const prompt = messages.map((message) => {
        if (message.role === "user") return message.content;
        if (message.role === "assistant") return message.blocks.map((block) => block.kind === "text" ? block.text : `[tool:${block.id}]`).join("");
        return message.results.map((result) => result.content).join("\n");
      }).join("\n\n");
      for await (const event of value.streamReply({ prompt, signal })) {
        yield event.kind === "text" ? event : { kind: "usage", usage: event.usage };
      }
      if (!signal.aborted) yield { kind: "stop", reason: "end_turn" };
    },
  };
}
