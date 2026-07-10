import { expect, test } from "bun:test";

import { runQueuedTurn } from "./agent-loop";
import { ScriptedModelProvider } from "./model-provider";

test("persists each scripted response prefix before completing a turn", async () => {
  const updates: string[] = [];
  const handled = await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      appendAssistantText: async ({ content }) => { updates.push(content); },
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "hello", threadId: "thread" }),
      completeAssistantMessage: async () => undefined,
    },
    provider: new ScriptedModelProvider({ chunks: ["Hello", " world"] }),
  });

  expect(handled).toBe(true);
  expect(updates).toEqual(["Hello", "Hello world"]);
});
