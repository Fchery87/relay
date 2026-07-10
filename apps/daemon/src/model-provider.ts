export interface ModelProvider {
  streamReply(input: { prompt: string }): AsyncIterable<string>;
}

export class ScriptedModelProvider implements ModelProvider {
  readonly #chunks: readonly string[];

  constructor({ chunks }: { chunks: readonly string[] }) {
    this.#chunks = chunks;
  }

  async *streamReply(): AsyncIterable<string> {
    yield* this.#chunks;
  }
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
      body: JSON.stringify({ input: prompt, model: this.#model }),
      headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error(`OpenAI response failed: ${response.status}`);
    const payload: unknown = await response.json();
    if (!isResponsePayload(payload)) throw new Error("OpenAI response had no output text");
    yield payload.output_text;
  }
}

function isResponsePayload(value: unknown): value is { output_text: string } {
  return typeof value === "object" && value !== null && "output_text" in value && typeof value.output_text === "string";
}
