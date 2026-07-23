import { tokenUsageSchema, type CatalogModel, type ThinkingLevel, type TokenUsage } from "@relay/shared";
import { z } from "zod";

import { buildProviderRequest, buildProviderToolRequest, mcpModelName, type ProviderConfig } from "./model-router";
import type { ToolCall } from "./tool-executor";
import type { TurnModelProvider } from "./turn-loop";
import { AnthropicTurnProvider } from "./providers/anthropic-turn-provider";
import { OpenAIResponsesTurnProvider } from "./providers/openai-responses-turn-provider";
import { OpenAICompletionsTurnProvider } from "./providers/openai-completions-turn-provider";

export interface ModelProvider {
  readonly modelId?: string;
  streamReply(input: { prompt: string; signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
  toolCalls?(input: { prompt: string; tools?: McpModelTool[] }): AsyncIterable<import("./tool-executor").ToolCall>;
}

export type McpModelTool = { description?: string; inputSchema: Record<string, unknown>; name: string; risk: "low" | "high" | "critical"; serverId: string };

export type ModelStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "usage"; usage: TokenUsage };

export interface ModelProviderRouter {
  readonly kind: "model-router";
  resolve(input: { modelId: string; thinkingLevel: ThinkingLevel }): ModelProvider;
  resolveTurn?(input: { modelId: string; thinkingLevel: ThinkingLevel }): TurnModelProvider;
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

  async *streamReply({ prompt, signal }: { prompt: string; signal: AbortSignal }): AsyncIterable<ModelStreamEvent> {
    const request = buildProviderRequest({ apiKey: this.#apiKey, model: this.#model, prompt, thinkingValue: this.#thinkingValue });
    const response = await this.#fetcher(request.url, { body: JSON.stringify(request.body), headers: request.headers, method: "POST", signal });
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
        } else if (this.#model.apiKind === "openai-completions") {
          // DeepSeek attaches `usage` to the same chunk as the final (empty) content delta and
          // finish_reason, rather than a separate chunk with an empty `choices` array — check both.
          if (isChatDelta(payload)) {
            const text = payload.choices[0]?.delta.content;
            if (text) yield { kind: "text", text };
          }
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

  async *toolCalls({ prompt, tools = [] }: { prompt: string; tools?: McpModelTool[] }): AsyncIterable<ToolCall> {
    const request = buildProviderToolRequest({ apiKey: this.#apiKey, mcpTools: tools, model: this.#model, prompt, thinkingValue: this.#thinkingValue });
    const response = await this.#fetcher(request.url, { body: JSON.stringify(request.body), headers: request.headers, method: "POST" });
    if (!response.ok) throw new Error(`${this.#model.provider} tool response failed: ${response.status}`);
    const payload: unknown = await response.json();
    for (const call of parseProviderToolCalls(payload, this.#model.apiKind, tools)) yield call;
  }
}

export class ScriptedModelProvider implements ModelProvider {
  readonly #chunks: readonly string[];
  readonly #toolCalls: readonly import("./tool-executor").ToolCall[];
  readonly #usage: TokenUsage;
  readonly #modelId: string;

  get modelId(): string { return this.#modelId; }

  constructor({ chunks, modelId = "deepseek/deepseek-v4-flash", toolCalls = [], usage = zeroUsage() }: {
    chunks: readonly string[];
    modelId?: string;
    toolCalls?: readonly import("./tool-executor").ToolCall[];
    usage?: TokenUsage;
  }) {
    this.#chunks = chunks;
    this.#modelId = modelId;
    this.#toolCalls = toolCalls;
    this.#usage = tokenUsageSchema.parse(usage);
  }

  async *streamReply({ signal }: { prompt: string; signal: AbortSignal }): AsyncIterable<ModelStreamEvent> {
    for (const text of this.#chunks) {
      if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
      yield { kind: "text", text };
    }
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
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

const toolCallSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), limit: z.number().optional(), offset: z.number().optional(), path: z.string() }),
  z.object({ content: z.string(), kind: z.literal("edit"), path: z.string() }),
  z.object({ kind: z.literal("str_replace"), newString: z.string(), oldString: z.string(), path: z.string(), replaceAll: z.boolean().optional() }),
  z.object({ glob: z.string().optional(), kind: z.literal("grep"), path: z.string().optional(), pattern: z.string() }),
  z.object({ kind: z.literal("glob"), pattern: z.string() }),
  z.object({ command: z.string(), kind: z.literal("bash"), timeout: z.number().optional() }),
  z.object({ capabilities: z.array(z.enum(["read", "edit", "exec", "task"])), kind: z.literal("task"), role: z.string(), task: z.string() }),
  z.object({ items: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })), kind: z.literal("todo") }),
  z.object({ kind: z.literal("web_search"), query: z.string() }),
  z.object({ kind: z.literal("web_fetch"), prompt: z.string().optional(), url: z.string() }),
  z.object({ kind: z.literal("skill"), name: z.string() }),
]);

function parseProviderToolCalls(payload: unknown, apiKind: CatalogModel["apiKind"], mcpTools: McpModelTool[] = []): ToolCall[] {
  const raw: Array<{ arguments: unknown; name: unknown }> = [];
  if (typeof payload !== "object" || payload === null) return [];
  if (apiKind === "anthropic-messages" && "content" in payload && Array.isArray(payload.content)) {
    for (const item of payload.content) if (typeof item === "object" && item !== null && "type" in item && item.type === "tool_use" && "name" in item && "input" in item) raw.push({ arguments: item.input, name: item.name });
  } else if (apiKind === "openai-responses" && "output" in payload && Array.isArray(payload.output)) {
    for (const item of payload.output) if (typeof item === "object" && item !== null && "type" in item && item.type === "function_call" && "name" in item && "arguments" in item) raw.push({ arguments: item.arguments, name: item.name });
  } else if ("choices" in payload && Array.isArray(payload.choices)) {
    const first = payload.choices[0];
    if (typeof first === "object" && first !== null && "message" in first && typeof first.message === "object" && first.message !== null && "tool_calls" in first.message && Array.isArray(first.message.tool_calls)) for (const item of first.message.tool_calls) {
      if (typeof item === "object" && item !== null && "function" in item && typeof item.function === "object" && item.function !== null && "name" in item.function && "arguments" in item.function) raw.push({ arguments: item.function.arguments, name: item.function.name });
    }
  }
  return raw.map(({ arguments: args, name }) => {
    const modelName = typeof name === "string" ? name : "";
    const mcpTool = mcpTools.find((tool, index) => mcpModelName(tool, index) === modelName);
    if (mcpTool) return { arguments: parseArguments(args), kind: "mcp", name: mcpTool.name, risk: mcpTool.risk, serverId: mcpTool.serverId };
    const parsedArgs = parseArguments(args);
    // Map native tool names to Relay tool kinds. Anthropic uses "WebSearch"
    // (via Claude Code) or "web_search"; OpenAI may use different naming.
    const normalizedKind = modelName.toLowerCase();
    if (normalizedKind === "web_search" || normalizedKind === "websearch") {
      return toolCallSchema.parse({ kind: "web_search", query: typeof parsedArgs.query === "string" ? parsedArgs.query : (typeof parsedArgs.search_term === "string" ? parsedArgs.search_term : JSON.stringify(parsedArgs)) });
    }
    if (normalizedKind === "web_fetch" || normalizedKind === "webfetch") {
      return toolCallSchema.parse({ kind: "web_fetch", url: typeof parsedArgs.url === "string" ? parsedArgs.url : "", prompt: typeof parsedArgs.prompt === "string" ? parsedArgs.prompt : undefined });
    }
    return toolCallSchema.parse({ ...parsedArgs, kind: name });
  });
}


function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Tool arguments must be an object");
    return parsed as Record<string, unknown>;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Tool arguments must be an object");
  return value as Record<string, unknown>;
}

export function resolveTurnProvider(config: ProviderConfig): TurnModelProvider {
  const providerModelId = config.model.id.slice(config.model.provider.length + 1);
  if (config.model.apiKind === "anthropic-messages") {
    return new AnthropicTurnProvider({
      apiKey: config.apiKey,
      model: providerModelId,
      thinkingBudget: config.thinkingValue === null ? undefined : Number(config.thinkingValue),
    });
  }
  if (config.model.apiKind === "openai-responses") {
    return new OpenAIResponsesTurnProvider({
      apiKey: config.apiKey,
      model: providerModelId,
      reasoningEffort: config.thinkingValue ?? undefined,
    });
  }
  return new OpenAICompletionsTurnProvider({
    apiKey: config.apiKey,
    model: providerModelId,
    reasoningEffort: config.thinkingValue ?? undefined,
    thinkingDisabled: config.thinkingValue === null,
  });
}
