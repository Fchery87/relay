import { expect, test } from "bun:test";

import { MODEL_CATALOG } from "@relay/shared";
import { CatalogModelProvider } from "./model-provider";

async function collect(provider: CatalogModelProvider): Promise<string> {
  let text = "";
  for await (const chunk of provider.streamReply({ prompt: "hello" })) text += chunk;
  return text;
}

test("streams Anthropic Messages text deltas", async () => {
  const model = MODEL_CATALOG.models.find((entry) => entry.apiKind === "anthropic-messages")!;
  const provider = new CatalogModelProvider({
    apiKey: "secret",
    fetcher: async () => new Response('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n'),
    model,
    thinkingValue: null,
  });
  expect(await collect(provider)).toBe("Hello");
});

test("streams OpenAI Responses text deltas", async () => {
  const model = MODEL_CATALOG.models.find((entry) => entry.apiKind === "openai-responses")!;
  const provider = new CatalogModelProvider({
    apiKey: "secret",
    fetcher: async () => new Response('data: {"type":"response.output_text.delta","delta":"Hello"}\n\n'),
    model,
    thinkingValue: "low",
  });
  expect(await collect(provider)).toBe("Hello");
});

test("streams OpenAI-compatible completion deltas", async () => {
  const model = MODEL_CATALOG.models.find((entry) => entry.apiKind === "openai-completions")!;
  const provider = new CatalogModelProvider({
    apiKey: "secret",
    fetcher: async () => new Response('data: {"choices":[{}]}\n\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n'),
    model,
    thinkingValue: null,
  });
  expect(await collect(provider)).toBe("Hello");
});
