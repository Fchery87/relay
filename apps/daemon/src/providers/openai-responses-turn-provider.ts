import { tokenUsageSchema, type TokenUsage } from "@relay/shared";
import { z } from "zod";

import { getToolDescription } from "../tool-descriptions";
import { toolCallSchema, toolCallToArgs } from "./shared";
import type { ToolCall } from "../tool-executor";
import type { ChatMessage, TurnModelProvider, TurnStreamEvent } from "../turn-loop";
import type { McpModelTool } from "../model-provider";
import { mcpModelName, TOOL_PARAMETERS } from "../model-router";

export interface OpenAIResponsesConfig {
  apiKey: string;
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  model: string;
  reasoningEffort?: string;
}

export class OpenAIResponsesTurnProvider implements TurnModelProvider {
  readonly #apiKey: string;
  readonly #fetcher: (input: string, init: RequestInit) => Promise<Response>;
  readonly #model: string;
  readonly #reasoningEffort?: string;

  get modelId(): string { return `openai/${this.#model}`; }

  constructor({ apiKey, fetcher = (input, init) => fetch(input, init), model, reasoningEffort }: OpenAIResponsesConfig) {
    this.#apiKey = apiKey;
    this.#fetcher = fetcher;
    this.#model = model;
    this.#reasoningEffort = reasoningEffort;
  }

  async *streamTurn({ messages, signal, system, tools }: {
    messages: ChatMessage[];
    signal: AbortSignal;
    system: string;
    tools: McpModelTool[];
  }): AsyncIterable<TurnStreamEvent> {
    const body = this.#buildRequest(messages, system, tools);
    const response = await this.#fetcher("https://api.openai.com/v1/responses", {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal,
    });
    if (!response.ok) throw new Error(`OpenAI Responses failed: ${response.status}`);
    if (!response.body) throw new Error("OpenAI Responses did not stream a body");

    const decoder = new TextDecoder();
    let buffer = "";

    // Track function calls by item index
    const functionCallItems: Array<{ callId: string; name: string }> = [];

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

        // Text delta
        if (isTextDelta(payload)) {
          yield { kind: "text", text: payload.delta };
        }
        // Function call added
        else if (isOutputItemAdded(payload) && payload.item.type === "function_call") {
          functionCallItems[payload.output_index] = { callId: payload.item.call_id, name: payload.item.name };
        }
        // Function call arguments done
        else if (isOutputItemDone(payload) && payload.item.type === "function_call") {
          const item = functionCallItems[payload.output_index];
          if (item) {
            const call = parseToolCall(item.name, JSON.parse(payload.item.arguments ?? "{}"), tools);
            if (call) yield { call, id: item.callId, kind: "tool_use" };
          }
        }
        // Response completed
        else if (isResponseCompleted(payload)) {
          const usage = parseResponsesUsage(payload);
          if (usage) yield { kind: "usage", usage };
          const status = payload.response.status;
          if (status === "completed") yield { kind: "stop", reason: "end_turn" };
          else if (status?.includes("tool_calls")) yield { kind: "stop", reason: "tool_use" };
          else if (status?.includes("max")) yield { kind: "stop", reason: "max_tokens" };
          else yield { kind: "stop", reason: "end_turn" };
        }
      }
    }
  }

  #buildRequest(messages: ChatMessage[], system: string, tools: McpModelTool[]): Record<string, unknown> {
    const input: unknown[] = [];
    if (system) input.push({ role: "system", content: system });

    for (const msg of messages) {
      if (msg.role === "user") {
        input.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        for (const block of msg.blocks) {
          if (block.kind === "text") {
            input.push({ role: "assistant", content: block.text });
          } else if (block.kind === "tool_use") {
            input.push({
              call_id: block.id,
              name: mapToolName(block.call, tools),
              arguments: JSON.stringify(toolCallToArgs(block.call)),
              type: "function_call",
            });
          }
        }
      } else if (msg.role === "tool_results") {
        for (const r of msg.results) {
          input.push({
            call_id: r.toolUseId,
            output: r.content,
            type: "function_call_output",
          });
        }
      }
    }

    const toolDefs = buildToolDefinitions(tools);
    const request: Record<string, unknown> = {
      input,
      model: this.#model,
      stream: true,
    };

    if (toolDefs.length > 0) request.tools = toolDefs;
    if (this.#reasoningEffort) request.reasoning = { effort: this.#reasoningEffort };

    return request;
  }
}

function buildToolDefinitions(mcpTools: McpModelTool[]): Array<{ description: string; name: string; parameters: Record<string, unknown>; type: "function" }> {
  const definitions: Array<{ description: string; name: string; parameters: Record<string, unknown>; type: "function" }> = [];
  const nativeTools = ["bash", "read", "edit", "str_replace", "grep", "glob", "todo", "task", "web_search", "web_fetch", "skill"];

  for (const name of nativeTools) {
    definitions.push({
      description: getToolDescription(name),
      name,
      parameters: (TOOL_PARAMETERS as Record<string, Record<string, unknown>>)[name] ?? { type: "object", properties: {}, required: [] },
      type: "function",
    });
  }

  for (const [index, tool] of mcpTools.entries()) {
    definitions.push({
      description: tool.description ?? `MCP ${tool.serverId}/${tool.name}`,
      name: mcpModelName(tool, index),
      parameters: tool.inputSchema,
      type: "function",
    });
  }

  return definitions;
}

function mapToolName(call: ToolCall, tools: McpModelTool[]): string {
  if (call.kind === "mcp") {
    const index = tools.findIndex((t) => t.name === call.name && t.serverId === call.serverId);
    return mcpModelName(tools[index] ?? { name: call.name, serverId: call.serverId }, Math.max(0, index));
  }
  return call.kind;
}

function parseToolCall(modelName: string, args: unknown, mcpTools: McpModelTool[]): ToolCall | null {
  const parsedArgs = typeof args === "string" ? JSON.parse(args) : args;
  if (typeof parsedArgs !== "object" || parsedArgs === null) return null;

  const mcpTool = mcpTools.find((tool, index) => mcpModelName(tool, index) === modelName);
  if (mcpTool) return { arguments: parsedArgs as Record<string, unknown>, kind: "mcp", name: mcpTool.name, risk: mcpTool.risk, serverId: mcpTool.serverId };

  try {
    return toolCallSchema.parse({ ...(parsedArgs as Record<string, unknown>), kind: modelName });
  } catch {
    return null;
  }
}

// SSE event type guards
function isTextDelta(value: unknown): value is { delta: string; type: "response.output_text.delta" } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "response.output_text.delta" && "delta" in value && typeof value.delta === "string";
}

function isOutputItemAdded(value: unknown): value is { item: { call_id: string; name: string; type: "function_call" }; output_index: number; type: "response.output_item.added" } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "response.output_item.added" && "item" in value;
}

function isOutputItemDone(value: unknown): value is { item: { arguments?: string; type: "function_call" }; output_index: number; type: "response.output_item.done" } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "response.output_item.done" && "item" in value;
}

function isResponseCompleted(value: unknown): value is { response: { status: string; usage: { input_tokens: number; input_tokens_details?: { cached_tokens?: number }; output_tokens: number; output_tokens_details?: { reasoning_tokens?: number } } }; type: "response.completed" } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "response.completed";
}

function parseResponsesUsage(value: unknown): TokenUsage | null {
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "response.completed") return null;
  const usage = (value as Record<string, unknown>).response as Record<string, unknown> | undefined;
  if (!usage || !usage.usage) return null;
  const u = usage.usage as Record<string, number>;
  const details = u.input_tokens_details as Record<string, number> | undefined;
  const outputDetails = u.output_tokens_details as Record<string, number> | undefined;
  return tokenUsageSchema.parse({
    cacheReadTokens: details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    thinkingTokens: outputDetails?.reasoning_tokens ?? 0,
  });
}
