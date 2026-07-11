import type { CatalogModel, ThinkingLevel } from "@relay/shared";

import { buildProviderRequest } from "./model-router";

export interface ModelProvider {
  streamReply(input: { prompt: string }): AsyncIterable<string>;
  toolCalls?(input: { prompt: string }): AsyncIterable<import("./tool-executor").ToolCall>;
}

export interface ModelProviderRouter {
  readonly kind: "model-router";
  resolve(input: { modelId: string; thinkingLevel: ThinkingLevel }): ModelProvider;
}

export class CatalogModelProvider implements ModelProvider {
  readonly #apiKey: string;
  readonly #fetcher: (input: string, init: RequestInit) => Promise<Response>;
  readonly #model: CatalogModel;
  readonly #thinkingValue: string | null;

  constructor({ apiKey, fetcher = (input, init) => fetch(input, init), model, thinkingValue }: {
    apiKey: string;
    fetcher?: (input: string, init: RequestInit) => Promise<Response>;
    model: CatalogModel;
    thinkingValue: string | null;
  }) {
    this.#apiKey = apiKey;
    this.#fetcher = fetcher;
    this.#model = model;
    this.#thinkingValue = thinkingValue;
  }

  async *streamReply({ prompt }: { prompt: string }): AsyncIterable<string> {
    const request = buildProviderRequest({ apiKey: this.#apiKey, model: this.#model, prompt, thinkingValue: this.#thinkingValue });
    const response = await this.#fetcher(request.url, { body: JSON.stringify(request.body), headers: request.headers, method: "POST" });
    if (!response.ok) throw new Error(`${this.#model.provider} response failed: ${response.status}`);
    if (!response.body) throw new Error(`${this.#model.provider} response did not stream a body`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;
        const payload: unknown = JSON.parse(data);
        if (this.#model.apiKind === "openai-responses" && isTextDelta(payload)) yield payload.delta;
        else if (this.#model.apiKind === "openai-completions" && isChatDelta(payload)) yield payload.choices[0]?.delta.content ?? "";
        else if (this.#model.apiKind === "anthropic-messages" && isAnthropicTextDelta(payload)) yield payload.delta.text;
      }
    }
  }
}

export class ScriptedModelProvider implements ModelProvider {
  readonly #chunks: readonly string[];
  readonly #toolCalls: readonly import("./tool-executor").ToolCall[];

  constructor({ chunks, toolCalls = [] }: { chunks: readonly string[]; toolCalls?: readonly import("./tool-executor").ToolCall[] }) {
    this.#chunks = chunks;
    this.#toolCalls = toolCalls;
  }

  async *streamReply(): AsyncIterable<string> {
    yield* this.#chunks;
  }

  async *toolCalls(): AsyncIterable<import("./tool-executor").ToolCall> { yield* this.#toolCalls; }
}

function isTextDelta(value: unknown): value is { delta: string; type: "response.output_text.delta" } {
  return typeof value === "object" && value !== null && "delta" in value && "type" in value && value.type === "response.output_text.delta" && typeof value.delta === "string";
}

function isChatDelta(value: unknown): value is { choices: Array<{ delta: { content?: string } }> } {
  if (typeof value !== "object" || value === null || !("choices" in value) || !Array.isArray(value.choices)) return false;
  const first = value.choices[0];
  if (typeof first !== "object" || first === null || !("delta" in first)) return false;
  const delta = first.delta;
  return typeof delta === "object" && delta !== null && (!("content" in delta) || typeof delta.content === "string");
}

function isAnthropicTextDelta(value: unknown): value is { delta: { text: string; type: "text_delta" }; type: "content_block_delta" } {
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "content_block_delta" || !("delta" in value)) return false;
  const delta = value.delta;
  return typeof delta === "object" && delta !== null && "type" in delta && delta.type === "text_delta" && "text" in delta && typeof delta.text === "string";
}
