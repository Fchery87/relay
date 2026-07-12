import { expect, test } from "bun:test";

import { MODEL_CATALOG } from "@relay/shared";
import { CatalogModelProvider } from "./model-provider";

async function collect(provider: CatalogModelProvider): Promise<{ text: string; usages: unknown[] }> {
  let text = "";
  const usages: unknown[] = [];
  for await (const chunk of provider.streamReply({ prompt: "hello", signal: new AbortController().signal })) {
    const event: unknown = chunk;
    if (typeof event === "string") text += event;
    else if (typeof event === "object" && event !== null && "kind" in event && event.kind === "text" && "text" in event && typeof event.text === "string") text += event.text;
    else if (typeof event === "object" && event !== null && "kind" in event && event.kind === "usage" && "usage" in event) usages.push(event.usage);
  }
  return { text, usages };
}

test("streams Anthropic Messages text deltas", async () => {
  const model = MODEL_CATALOG.models.find((entry) => entry.apiKind === "anthropic-messages")!;
  const provider = new CatalogModelProvider({
    apiKey: "secret",
    fetcher: async () => new Response('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":700,"cache_creation_input_tokens":100,"cache_read_input_tokens":200}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":50}}\n\n'),
    model,
    thinkingValue: "1024",
  });
  expect(await collect(provider)).toEqual({
    text: "Hello",
    usages: [{ cacheReadTokens: 200, cacheWriteTokens: 100, inputTokens: 1_000, outputTokens: 50, thinkingTokens: null }],
  });
});

test("streams OpenAI Responses text deltas", async () => {
  const model = MODEL_CATALOG.models.find((entry) => entry.apiKind === "openai-responses")!;
  const provider = new CatalogModelProvider({
    apiKey: "secret",
    fetcher: async () => new Response('data: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":250},"output_tokens":400,"output_tokens_details":{"reasoning_tokens":100}}}}\n\n'),
    model,
    thinkingValue: "low",
  });
  expect(await collect(provider)).toEqual({
    text: "Hello",
    usages: [{ cacheReadTokens: 250, cacheWriteTokens: 0, inputTokens: 1_000, outputTokens: 400, thinkingTokens: 100 }],
  });
});

test("streams OpenAI-compatible completion deltas", async () => {
  const model = MODEL_CATALOG.models.find((entry) => entry.apiKind === "openai-completions")!;
  const provider = new CatalogModelProvider({
    apiKey: "secret",
    fetcher: async () => new Response('data: {"choices":[{}]}\n\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1200,"prompt_cache_hit_tokens":300,"completion_tokens":500,"completion_tokens_details":{"reasoning_tokens":200}}}\n\ndata: [DONE]\n\n'),
    model,
    thinkingValue: null,
  });
  expect(await collect(provider)).toEqual({
    text: "Hello",
    usages: [{ cacheReadTokens: 300, cacheWriteTokens: 0, inputTokens: 1_200, outputTokens: 500, thinkingTokens: 200 }],
  });
});

test("passes the turn abort signal to the provider request", async () => {
  const model = MODEL_CATALOG.models.find((entry) => entry.apiKind === "openai-responses")!;
  const controller = new AbortController();
  let receivedSignal: AbortSignal | null | undefined;
  const provider = new CatalogModelProvider({
    apiKey: "secret",
    fetcher: async (_input, init) => {
      receivedSignal = init.signal;
      return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n');
    },
    model,
    thinkingValue: null,
  });

  for await (const _event of provider.streamReply({ prompt: "hello", signal: controller.signal })) {
    // Consume the stream so the request is issued.
  }
  expect(receivedSignal).toBe(controller.signal);
});
