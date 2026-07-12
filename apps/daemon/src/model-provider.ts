import { tokenUsageSchema, type CatalogModel, type ThinkingLevel, type TokenUsage } from "@relay/shared";
import { z } from "zod";

import { buildProviderRequest } from "./model-router";

export interface ModelProvider {
  readonly modelId?: string;
  streamReply(input: { prompt: string }): AsyncIterable<ModelStreamEvent>;
  toolCalls?(input: { prompt: string }): AsyncIterable<import("./tool-executor").ToolCall>;
}

export type ModelStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "usage"; usage: TokenUsage };

export interface ModelProviderRouter {
  readonly kind: "model-router";
  resolve(input: { modelId: string; thinkingLevel: ThinkingLevel }): ModelProvider;
}

export class CatalogModelProvider implements ModelProvider {
  readonly #apiKey: string;
  readonly #fetcher: (input: string, init: RequestInit) => Promise<Response>;
  readonly #model: CatalogModel;
  readonly #thinkingValue: string | null;

  get modelId(): string { return this.#model.id; }

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

  async *streamReply({ prompt }: { prompt: string }): AsyncIterable<ModelStreamEvent> {
    const request = buildProviderRequest({ apiKey: this.#apiKey, model: this.#model, prompt, thinkingValue: this.#thinkingValue });
    const response = await this.#fetcher(request.url, { body: JSON.stringify(request.body), headers: request.headers, method: "POST" });
    if (!response.ok) throw new Error(`${this.#model.provider} response failed: ${response.status}`);
    if (!response.body) throw new Error(`${this.#model.provider} response did not stream a body`);
    const decoder = new TextDecoder();
    let buffer = "";
    let anthropicInput: Pick<TokenUsage, "cacheReadTokens" | "cacheWriteTokens" | "inputTokens"> | null = null;
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;
        const payload: unknown = JSON.parse(data);
        if (this.#model.apiKind === "openai-responses" && isTextDelta(payload)) yield { kind: "text", text: payload.delta };
        else if (this.#model.apiKind === "openai-responses") {
          const usage = parseResponsesUsage(payload);
          if (usage) yield { kind: "usage", usage };
        } else if (this.#model.apiKind === "openai-completions" && isChatDelta(payload)) {
          const text = payload.choices[0]?.delta.content;
          if (text) yield { kind: "text", text };
        } else if (this.#model.apiKind === "openai-completions") {
          const usage = parseCompletionsUsage(payload);
          if (usage) yield { kind: "usage", usage };
        } else if (this.#model.apiKind === "anthropic-messages" && isAnthropicTextDelta(payload)) {
          yield { kind: "text", text: payload.delta.text };
        } else if (this.#model.apiKind === "anthropic-messages") {
          anthropicInput = parseAnthropicInputUsage(payload) ?? anthropicInput;
          const outputTokens = parseAnthropicOutputTokens(payload);
          if (anthropicInput && outputTokens !== null) {
            yield { kind: "usage", usage: tokenUsageSchema.parse({ ...anthropicInput, outputTokens, thinkingTokens: this.#thinkingValue === null ? 0 : null }) };
          }
        }
      }
    }
  }
}

export class ScriptedModelProvider implements ModelProvider {
  readonly #chunks: readonly string[];
  readonly #toolCalls: readonly import("./tool-executor").ToolCall[];
  readonly #usage: TokenUsage;

  constructor({ chunks, toolCalls = [], usage = zeroUsage() }: { chunks: readonly string[]; toolCalls?: readonly import("./tool-executor").ToolCall[]; usage?: TokenUsage }) {
    this.#chunks = chunks;
    this.#toolCalls = toolCalls;
    this.#usage = tokenUsageSchema.parse(usage);
  }

  async *streamReply(): AsyncIterable<ModelStreamEvent> {
    for (const text of this.#chunks) yield { kind: "text", text };
    yield { kind: "usage", usage: this.#usage };
  }

  async *toolCalls(): AsyncIterable<import("./tool-executor").ToolCall> { yield* this.#toolCalls; }
}

const responsesCompletedSchema = z.object({
  response: z.object({
    usage: z.object({
      input_tokens: z.number().int().nonnegative(),
      input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).optional(),
      output_tokens: z.number().int().nonnegative(),
      output_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).optional(),
    }),
  }),
  type: z.literal("response.completed"),
});

const completionsUsageSchema = z.object({
  usage: z.object({
    completion_tokens: z.number().int().nonnegative(),
    completion_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).optional(),
    prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens: z.number().int().nonnegative(),
  }),
});

const anthropicInputSchema = z.object({
  message: z.object({
    usage: z.object({
      cache_creation_input_tokens: z.number().int().nonnegative().optional(),
      cache_read_input_tokens: z.number().int().nonnegative().optional(),
      input_tokens: z.number().int().nonnegative(),
    }),
  }),
  type: z.literal("message_start"),
});

const anthropicOutputSchema = z.object({
  type: z.literal("message_delta"),
  usage: z.object({ output_tokens: z.number().int().nonnegative() }),
});

function parseResponsesUsage(value: unknown): TokenUsage | null {
  const parsed = responsesCompletedSchema.safeParse(value);
  if (!parsed.success) return null;
  const usage = parsed.data.response.usage;
  return tokenUsageSchema.parse({
    cacheReadTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    thinkingTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  });
}

function parseCompletionsUsage(value: unknown): TokenUsage | null {
  const parsed = completionsUsageSchema.safeParse(value);
  if (!parsed.success) return null;
  const usage = parsed.data.usage;
  return tokenUsageSchema.parse({
    cacheReadTokens: usage.prompt_cache_hit_tokens ?? 0,
    cacheWriteTokens: 0,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    thinkingTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
  });
}

function parseAnthropicInputUsage(value: unknown): Pick<TokenUsage, "cacheReadTokens" | "cacheWriteTokens" | "inputTokens"> | null {
  const parsed = anthropicInputSchema.safeParse(value);
  if (!parsed.success) return null;
  const usage = parsed.data.message.usage;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  return { cacheReadTokens, cacheWriteTokens, inputTokens: usage.input_tokens + cacheReadTokens + cacheWriteTokens };
}

function parseAnthropicOutputTokens(value: unknown): number | null {
  const parsed = anthropicOutputSchema.safeParse(value);
  return parsed.success ? parsed.data.usage.output_tokens : null;
}

function zeroUsage(): TokenUsage {
  return { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
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
