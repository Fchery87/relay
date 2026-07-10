export interface ModelProvider {
  streamReply(input: { prompt: string }): AsyncIterable<string>;
  toolCalls?(input: { prompt: string }): AsyncIterable<import("./tool-executor").ToolCall>;
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

export class OpenAIResponsesProvider implements ModelProvider {
  readonly #apiKey: string;
  readonly #model: string;

  constructor({ apiKey, model }: { apiKey: string; model: string }) {
    this.#apiKey = apiKey;
    this.#model = model;
  }

  async *streamReply({ prompt }: { prompt: string }): AsyncIterable<string> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      body: JSON.stringify({ input: prompt, model: this.#model, stream: true }),
      headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error(`OpenAI response failed: ${response.status}`);
    if (!response.body) throw new Error("OpenAI response did not stream a body");
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload: unknown = JSON.parse(line.slice(6));
        if (isTextDelta(payload)) yield payload.delta;
      }
    }
  }
}

export class DeepSeekChatProvider implements ModelProvider {
  readonly #apiKey: string;
  readonly #model: string;

  constructor({ apiKey, model }: { apiKey: string; model: string }) {
    this.#apiKey = apiKey;
    this.#model = model;
  }

  async *streamReply({ prompt }: { prompt: string }): AsyncIterable<string> {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: prompt, role: "user" }],
        model: this.#model,
        stream: true,
      }),
      headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error(`DeepSeek response failed: ${response.status}`);
    if (!response.body) throw new Error("DeepSeek response did not stream a body");

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
        if (isChatDelta(payload)) yield payload.choices[0]?.delta.content ?? "";
      }
    }
  }
}

function isTextDelta(value: unknown): value is { delta: string; type: "response.output_text.delta" } {
  return typeof value === "object" && value !== null && "delta" in value && "type" in value && value.type === "response.output_text.delta" && typeof value.delta === "string";
}

function isChatDelta(value: unknown): value is { choices: Array<{ delta: { content?: string } }> } {
  return typeof value === "object" && value !== null && "choices" in value && Array.isArray(value.choices);
}
