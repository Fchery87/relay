import { tokenUsageSchema, type TokenUsage } from "@relay/shared";
import { z } from "zod";

import { getToolDescription } from "../tool-descriptions";
import { toolCallSchema, toolCallToArgs } from "./shared";
import type { ToolCall } from "../tool-executor";
import type { ChatMessage, TurnModelProvider, TurnStreamEvent } from "../turn-loop";
import type { McpModelTool } from "../model-provider";
import { mcpModelName, TOOL_PARAMETERS } from "../model-router";

export interface AnthropicConfig {
  apiKey: string;
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  model: string;
  maxTokens?: number;
  thinkingBudget?: number;
}

export class AnthropicTurnProvider implements TurnModelProvider {
  readonly #apiKey: string;
  readonly #fetcher: (input: string, init: RequestInit) => Promise<Response>;
  readonly #maxTokens: number;
  readonly #model: string;
  readonly #thinkingBudget?: number;

  get modelId(): string { return `anthropic/${this.#model}`; }

  constructor({ apiKey, fetcher = (input, init) => fetch(input, init), model, maxTokens = 16384, thinkingBudget }: AnthropicConfig) {
    this.#apiKey = apiKey;
    this.#fetcher = fetcher;
    this.#maxTokens = maxTokens;
    this.#model = model;
    this.#thinkingBudget = thinkingBudget;
  }

  async *streamTurn({ messages, signal, system, tools }: {
    messages: ChatMessage[];
    signal: AbortSignal;
    system: string;
    tools: McpModelTool[];
  }): AsyncIterable<TurnStreamEvent> {
    const body = this.#buildRequest(messages, system, tools);
    const response = await this.#fetcher("https://api.anthropic.com/v1/messages", {
      body: JSON.stringify(body),
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
      },
      method: "POST",
      signal,
    });
    if (!response.ok) throw new Error(`Anthropic response failed: ${response.status}`);
    if (!response.body) throw new Error("Anthropic response did not stream a body");

    const decoder = new TextDecoder();
    let buffer = "";
    let anthropicInput: Pick<TokenUsage, "cacheReadTokens" | "cacheWriteTokens" | "inputTokens"> | null = null;

    // Track tool_use blocks by index
    const toolUseBlocks: Array<{ id: string; name: string; jsonAccum: string }> = [];

    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        const payload: unknown = JSON.parse(data);

        if (typeof payload !== "object" || payload === null) continue;

        // text delta
        if (isTextDelta(payload)) {
          yield { kind: "text", text: payload.delta.text };
        }
        // tool_use start
        else if (isContentBlockStart(payload) && payload.content_block.type === "tool_use") {
          const block = payload.content_block;
          toolUseBlocks[payload.index] = { id: block.id, name: block.name, jsonAccum: "" };
        }
        // tool_use input delta
        else if (isContentBlockDelta(payload) && payload.delta.type === "input_json_delta") {
          const block = toolUseBlocks[payload.index];
          if (block) block.jsonAccum += payload.delta.partial_json;
        }
        // content block stop
        else if (isContentBlockStop(payload)) {
          const block = toolUseBlocks[payload.index];
          if (block && block.jsonAccum) {
            try {
              const parsedArgs = JSON.parse(block.jsonAccum);
              const call = parseToolCall(block.name, parsedArgs, tools);
              if (call) yield { call, id: block.id, kind: "tool_use" };
            } catch { /* partial JSON — skip */ }
          }
        }
        // message start (input usage)
        else if (isMessageStart(payload)) {
          anthropicInput = parseAnthropicInputUsage(payload);
        }
        // message delta (stop reason + output tokens)
        else if (isMessageDelta(payload)) {
          const stopReason = mapStopReason(payload.delta.stop_reason);
          yield { kind: "stop", reason: stopReason };
          const outputTokens = payload.usage.output_tokens;
          if (anthropicInput && outputTokens !== null) {
            yield {
              kind: "usage",
              usage: tokenUsageSchema.parse({
                ...anthropicInput,
                outputTokens,
                thinkingTokens: this.#thinkingBudget === undefined ? 0 : null,
              }),
            };
          }
        }
      }
    }
  }

  #buildRequest(messages: ChatMessage[], system: string, tools: McpModelTool[]): Record<string, unknown> {
    const anthropicMessages: unknown[] = [];
    const systemBlock: Array<{ text: string; type: "text" }> = system ? [{ text: system, type: "text" as const }] : [];

    for (const msg of messages) {
      if (msg.role === "user") {
        anthropicMessages.push({ content: msg.content, role: "user" });
      } else if (msg.role === "assistant") {
        const content: unknown[] = [];
        for (const block of msg.blocks) {
          if (block.kind === "text") {
            content.push({ text: block.text, type: "text" });
          } else if (block.kind === "tool_use") {
            content.push({
              id: block.id,
              input: toolCallToArgs(block.call),
              name: mapToolName(block.call, tools),
              type: "tool_use",
            });
          }
        }
        anthropicMessages.push({ content, role: "assistant" });
      } else if (msg.role === "tool_results") {
        const content = msg.results.map((r) => ({
          content: r.content,
          is_error: r.isError ?? false,
          tool_use_id: r.toolUseId,
          type: "tool_result" as const,
        }));
        anthropicMessages.push({ content, role: "user" });
      }
    }

    const toolDefs = buildToolDefinitions(tools);
    const request: Record<string, unknown> = {
      max_tokens: this.#maxTokens,
      messages: anthropicMessages,
      model: this.#model,
      stream: true,
      system: systemBlock,
    };

    if (toolDefs.length > 0) request.tools = toolDefs;
    if (this.#thinkingBudget !== undefined) {
      request.thinking = { budget_tokens: Math.min(this.#thinkingBudget, this.#maxTokens - 1024), type: "enabled" };
    }

    return request;
  }
}

function buildToolDefinitions(mcpTools: McpModelTool[]): Array<{ description: string; input_schema: Record<string, unknown>; name: string }> {
  const definitions: Array<{ description: string; input_schema: Record<string, unknown>; name: string }> = [];

  // Relay native tools
  const nativeTools = ["bash", "read", "edit", "str_replace", "grep", "glob", "todo", "task", "web_search", "web_fetch", "skill"];
  for (const name of nativeTools) {
    definitions.push({
      description: getToolDescription(name),
      input_schema: (TOOL_PARAMETERS as Record<string, Record<string, unknown>>)[name] ?? { type: "object", properties: {}, required: [] },
      name,
    });
  }

  // MCP tools
  for (const [index, tool] of mcpTools.entries()) {
    definitions.push({
      description: tool.description ?? `MCP ${tool.serverId}/${tool.name}`,
      input_schema: tool.inputSchema,
      name: mcpModelName(tool, index),
    });
  }

  return definitions;
}

function mapToolName(call: ToolCall, tools: McpModelTool[]): string {
  if (call.kind === "mcp") {
    const index = tools.findIndex((t) => t.name === call.name && t.serverId === call.serverId);
    return mcpModelName(tools[index] ?? { name: call.name, serverId: call.serverId }, Math.max(0, index));
  }
  if (call.kind === "web_search") return "web_search";
  if (call.kind === "web_fetch") return "web_fetch";
  return call.kind;
}

function parseToolCall(modelName: string, args: Record<string, unknown>, mcpTools: McpModelTool[]): ToolCall | null {
  const mcpTool = mcpTools.find((tool, index) => mcpModelName(tool, index) === modelName);
  if (mcpTool) return { arguments: args, kind: "mcp", name: mcpTool.name, risk: mcpTool.risk, serverId: mcpTool.serverId };

  try {
    return toolCallSchema.parse({ ...args, kind: modelName });
  } catch {
    return null;
  }
}

function mapStopReason(reason: string | null): "end_turn" | "max_tokens" | "tool_use" {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end_turn";
}

// SSE event type guards
function isTextDelta(value: unknown): value is { delta: { text: string; type: "text_delta" }; index: number; type: "content_block_delta" } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "content_block_delta" && "delta" in value &&
    typeof (value as Record<string, unknown>).delta === "object" && (value as Record<string, unknown>).delta !== null &&
    "type" in ((value as Record<string, unknown>).delta as Record<string, unknown>) && ((value as Record<string, unknown>).delta as Record<string, unknown>).type === "text_delta";
}

function isContentBlockStart(value: unknown): value is { content_block: { id: string; name: string; type: "tool_use" }; index: number; type: "content_block_start" } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "content_block_start" && "content_block" in value &&
    typeof (value as Record<string, unknown>).content_block === "object" && (value as Record<string, unknown>).content_block !== null &&
    "type" in ((value as Record<string, unknown>).content_block as Record<string, unknown>);
}

function isContentBlockDelta(value: unknown): value is { delta: { partial_json: string; type: "input_json_delta" }; index: number; type: "content_block_delta" } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "content_block_delta" && "delta" in value &&
    typeof (value as Record<string, unknown>).delta === "object";
}

function isContentBlockStop(value: unknown): value is { index: number; type: "content_block_stop" } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "content_block_stop";
}

function isMessageStart(value: unknown): value is { message: { usage: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number; input_tokens: number } }; type: "message_start" } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "message_start";
}

function isMessageDelta(value: unknown): value is { delta: { stop_reason: string | null; stop_sequence: string | null }; type: "message_delta"; usage: { output_tokens: number } } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "message_delta";
}

function parseAnthropicInputUsage(value: unknown): Pick<TokenUsage, "cacheReadTokens" | "cacheWriteTokens" | "inputTokens"> | null {
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "message_start") return null;
  const usage = (value as Record<string, unknown>).message as Record<string, unknown> | undefined;
  if (!usage || !usage.usage) return null;
  const u = usage.usage as Record<string, number>;
  const cacheReadTokens = u.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
  return { cacheReadTokens, cacheWriteTokens, inputTokens: (u.input_tokens ?? 0) + cacheReadTokens + cacheWriteTokens };
}
