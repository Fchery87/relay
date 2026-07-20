import { tokenUsageSchema, type TokenUsage } from "@relay/shared";
import { z } from "zod";

import { getToolDescription } from "../tool-descriptions";
import { toolCallSchema, toolCallToArgs } from "./shared";
import type { ToolCall } from "../tool-executor";
import type { ChatMessage, TurnModelProvider, TurnStreamEvent } from "../turn-loop";
import type { McpModelTool } from "../model-provider";
import { mcpModelName, TOOL_PARAMETERS } from "../model-router";

export interface OpenAICompletionsConfig {
  apiKey: string;
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  model: string;
  reasoningEffort?: string;
  thinkingDisabled?: boolean;
}

export class OpenAICompletionsTurnProvider implements TurnModelProvider {
  readonly #apiKey: string;
  readonly #fetcher: (input: string, init: RequestInit) => Promise<Response>;
  readonly #model: string;
  readonly #reasoningEffort?: string;
  readonly #thinkingDisabled?: boolean;
  readonly #baseUrl: string;

  get modelId(): string { return `${this.#baseUrl.includes("deepseek") ? "deepseek" : "openai"}/${this.#model}`; }

  constructor({ apiKey, fetcher = (input, init) => fetch(input, init), model, reasoningEffort, thinkingDisabled }: OpenAICompletionsConfig) {
    this.#apiKey = apiKey;
    this.#fetcher = fetcher;
    this.#model = model;
    this.#reasoningEffort = reasoningEffort;
    this.#thinkingDisabled = thinkingDisabled;
    // DeepSeek uses a different base URL
    this.#baseUrl = model.includes("deepseek") ? "https://api.deepseek.com" : "https://api.openai.com";
  }

  async *streamTurn({ messages, signal, system, tools }: {
    messages: ChatMessage[];
    signal: AbortSignal;
    system: string;
    tools: McpModelTool[];
  }): AsyncIterable<TurnStreamEvent> {
    const body = this.#buildRequest(messages, system, tools);
    const response = await this.#fetcher(`${this.#baseUrl}/v1/chat/completions`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal,
    });
    if (!response.ok) throw new Error(`Completions response failed: ${response.status}`);
    if (!response.body) throw new Error("Completions response did not stream a body");

    const decoder = new TextDecoder();
    let buffer = "";

    // Track tool calls by index (accumulated across deltas)
    const toolCallAccum: Array<{ id: string; name: string; arguments: string }> = [];

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

        // Text content delta
        if (isChatDelta(payload)) {
          const text = payload.choices[0]?.delta.content;
          if (text) yield { kind: "text", text };
        }

        // Tool call deltas
        const choices = (payload as { choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string; name?: string }; id?: string; index?: number }> }; finish_reason?: string | null }> }).choices;
        const toolCalls = choices?.[0]?.delta?.tool_calls;
        if (toolCalls) {
          for (const tc of toolCalls) {
            const index = tc.index ?? 0;
            if (!toolCallAccum[index]) toolCallAccum[index] = { id: "", name: "", arguments: "" };
            if (tc.id) toolCallAccum[index]!.id = tc.id;
            if (tc.function?.name) toolCallAccum[index]!.name += tc.function.name;
            if (tc.function?.arguments) toolCallAccum[index]!.arguments += tc.function.arguments;
          }
        }

        // Finish reason
        const finishReason = choices?.[0]?.finish_reason;
        if (finishReason) {
          // Emit accumulated tool calls
          for (const acc of toolCallAccum) {
            if (acc.id && acc.name) {
              try {
                const parsedArgs = JSON.parse(acc.arguments || "{}");
                const call = parseToolCall(acc.name, parsedArgs, tools);
                if (call) yield { call, id: acc.id, kind: "tool_use" };
              } catch { /* skip malformed */ }
            }
          }

          yield { kind: "stop", reason: mapFinishReason(finishReason) };
        }

        // Usage (may come in same or separate chunk)
        const usage = parseCompletionsUsage(payload);
        if (usage) yield { kind: "usage", usage };
      }
    }
  }

  #buildRequest(messages: ChatMessage[], system: string, tools: McpModelTool[]): Record<string, unknown> {
    const chatMessages: unknown[] = [];

    if (system) {
      chatMessages.push({ content: system, role: "system" });
    }

    for (const msg of messages) {
      if (msg.role === "user") {
        chatMessages.push({ content: msg.content, role: "user" });
      } else if (msg.role === "assistant") {
        const contentParts: Array<{ text: string; type: "text" }> = [];
        const toolCalls: Array<{ function: { arguments: string; name: string }; id: string; type: "function" }> = [];
        for (const block of msg.blocks) {
          if (block.kind === "text") {
            contentParts.push({ text: block.text, type: "text" });
          } else if (block.kind === "tool_use") {
            toolCalls.push({
              function: {
                arguments: JSON.stringify(toolCallToArgs(block.call)),
                name: mapToolName(block.call, tools),
              },
              id: block.id,
              type: "function",
            });
          }
        }
        const assistantMsg: Record<string, unknown> = { role: "assistant" };
        if (contentParts.length > 0) assistantMsg.content = contentParts.map((p) => p.text).join("");
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        chatMessages.push(assistantMsg);
      } else if (msg.role === "tool_results") {
        for (const r of msg.results) {
          chatMessages.push({
            content: r.content,
            role: "tool",
            tool_call_id: r.toolUseId,
          });
        }
      }
    }

    const toolDefs = buildToolDefinitions(tools);
    const request: Record<string, unknown> = {
      messages: chatMessages,
      model: this.#model,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (toolDefs.length > 0) request.tools = toolDefs;

    // Thinking / reasoning configuration
    if (this.#thinkingDisabled) {
      request.thinking = { type: "disabled" };
    } else if (this.#reasoningEffort) {
      request.reasoning_effort = this.#reasoningEffort;
    }

    return request;
  }
}

function buildToolDefinitions(mcpTools: McpModelTool[]): Array<{ function: { description: string; name: string; parameters: Record<string, unknown> }; type: "function" }> {
  const definitions: Array<{ function: { description: string; name: string; parameters: Record<string, unknown> }; type: "function" }> = [];
  const nativeTools = ["bash", "read", "edit", "str_replace", "grep", "glob", "todo", "task", "web_search", "web_fetch", "skill"];

  for (const name of nativeTools) {
    definitions.push({
      function: {
        description: getToolDescription(name),
        name,
        parameters: (TOOL_PARAMETERS as Record<string, Record<string, unknown>>)[name] ?? { type: "object", properties: {}, required: [] },
      },
      type: "function",
    });
  }

  for (const [index, tool] of mcpTools.entries()) {
    definitions.push({
      function: {
        description: tool.description ?? `MCP ${tool.serverId}/${tool.name}`,
        name: mcpModelName(tool, index),
        parameters: tool.inputSchema,
      },
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

function parseToolCall(modelName: string, args: Record<string, unknown>, mcpTools: McpModelTool[]): ToolCall | null {
  const mcpTool = mcpTools.find((tool, index) => mcpModelName(tool, index) === modelName);
  if (mcpTool) return { arguments: args, kind: "mcp", name: mcpTool.name, risk: mcpTool.risk, serverId: mcpTool.serverId };

  try {
    return toolCallSchema.parse({ ...args, kind: modelName });
  } catch {
    return null;
  }
}

function mapFinishReason(reason: string | null): "end_turn" | "max_tokens" | "tool_use" {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

// SSE event type guards
function isChatDelta(value: unknown): value is { choices: Array<{ delta: { content?: string; tool_calls?: Array<{ function?: { arguments?: string; name?: string }; id?: string; index?: number }> }; finish_reason?: string | null }> } {
  if (typeof value !== "object" || value === null || !("choices" in value) || !Array.isArray(value.choices)) return false;
  const first = value.choices[0];
  return typeof first === "object" && first !== null && "delta" in first;
}

function parseCompletionsUsage(value: unknown): TokenUsage | null {
  if (typeof value !== "object" || value === null || !("usage" in value)) return null;
  const usage = value.usage as Record<string, unknown>;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, number>;
  const details = u.completion_tokens_details as Record<string, number> | undefined;
  return tokenUsageSchema.parse({
    cacheReadTokens: (u.prompt_cache_hit_tokens ?? 0),
    cacheWriteTokens: 0,
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    thinkingTokens: details?.reasoning_tokens ?? 0,
  });
}
