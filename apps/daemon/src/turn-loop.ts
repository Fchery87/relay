import type { TokenUsage } from "@relay/shared";
import type { McpModelTool } from "./model-provider";
import type { ToolCall } from "./tool-executor";

export type AssistantBlock = { kind: "text"; text: string } | { call: ToolCall; id: string; kind: "tool_use" };
export type ChatMessage =
  | { content: string; role: "user" }
  | { blocks: AssistantBlock[]; role: "assistant" }
  | { results: Array<{ content: string; isError?: boolean; toolUseId: string }>; role: "tool_results" };

export type TurnStreamEvent =
  | { kind: "text"; text: string }
  | { call: ToolCall; id: string; kind: "tool_use" }
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "stop"; reason: "end_turn" | "max_tokens" | "tool_use" };

export interface TurnModelProvider {
  readonly modelId?: string;
  streamTurn(input: { messages: ChatMessage[]; signal: AbortSignal; system: string; tools: McpModelTool[] }): AsyncIterable<TurnStreamEvent>;
}

export interface TurnCallbacks {
  executeToolCall(call: ToolCall): Promise<{ content: string; isError?: boolean; toolUseId: string }>;
  onText?(text: string): Promise<void>;
  claimSteering?(): Promise<string[]>;
  onUsage?(usage: TokenUsage): void;
}

export async function runAgenticTurn({
  messages: initialMessages,
  maxIterations = 50,
  provider,
  signal,
  system,
  tools,
  callbacks,
}: {
  messages: ChatMessage[];
  maxIterations?: number;
  provider: TurnModelProvider;
  signal: AbortSignal;
  system: string;
  tools: McpModelTool[];
  callbacks: TurnCallbacks;
}): Promise<{ messages: ChatMessage[]; totalUsage: TokenUsage }> {
  const messages = [...initialMessages];
  let totalUsage: TokenUsage = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
  let exhausted = false;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal.aborted) break;

    // Check for steering messages between iterations
    if (callbacks.claimSteering && iteration > 0) {
      const steering = await callbacks.claimSteering();
      for (const content of steering) {
        messages.push({ content, role: "user" });
      }
      if (steering.length > 0 && messages.length > 0) {
        // Steering was injected — continue loop to re-stream
      }
    }

    const assistantBlocks: AssistantBlock[] = [];
    const toolUses: Array<{ call: ToolCall; id: string }> = [];
    let stopReason: "end_turn" | "max_tokens" | "tool_use" = "end_turn";

    // Stream the turn
    for await (const event of provider.streamTurn({ messages, signal, system, tools })) {
      if (signal.aborted) break;
      if (event.kind === "text") {
        assistantBlocks.push({ kind: "text", text: event.text });
        await callbacks.onText?.(event.text);
      } else if (event.kind === "tool_use") {
        assistantBlocks.push({ call: event.call, id: event.id, kind: "tool_use" });
        toolUses.push({ call: event.call, id: event.id });
      } else if (event.kind === "usage") {
        const usage = event.usage;
        totalUsage = {
          cacheReadTokens: totalUsage.cacheReadTokens + usage.cacheReadTokens,
          cacheWriteTokens: totalUsage.cacheWriteTokens + usage.cacheWriteTokens,
          inputTokens: totalUsage.inputTokens + usage.inputTokens,
          outputTokens: totalUsage.outputTokens + usage.outputTokens,
          thinkingTokens: totalUsage.thinkingTokens + usage.thinkingTokens,
        };
        callbacks.onUsage?.(usage);
      } else if (event.kind === "stop") {
        stopReason = event.reason;
      }
    }

    if (signal.aborted) break;

    // Push the assistant message
    if (assistantBlocks.length > 0) {
      messages.push({ blocks: assistantBlocks, role: "assistant" });
    }

    // If stop reason is tool_use, execute tools and continue
    if (stopReason === "tool_use" && toolUses.length > 0) {
      const results: Array<{ content: string; isError?: boolean; toolUseId: string }> = [];
      for (const { call, id } of toolUses) {
        try {
          const result = await callbacks.executeToolCall(call);
          results.push({ ...result, toolUseId: id });
        } catch (error) {
          results.push({ content: error instanceof Error ? error.message : "Tool execution failed", isError: true, toolUseId: id });
        }
      }
      messages.push({ results, role: "tool_results" });
      // Continue loop — model gets tool results and may produce more
      continue;
    }

    // No more tool calls — end turn
    break;
  }

  return { messages, totalUsage };
}
