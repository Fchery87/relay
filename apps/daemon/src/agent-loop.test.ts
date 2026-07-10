import { expect, test } from "bun:test";

import { runQueuedTurn } from "./agent-loop";
import { ScriptedModelProvider } from "./model-provider";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

test("coalesces rapid scripted chunks into a final persisted response", async () => {
  const updates: string[] = [];
  const handled = await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      appendAssistantText: async ({ content }) => { updates.push(content); },
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "hello", projectPath: "/tmp", threadId: "thread" }),
      completeAssistantMessage: async () => undefined,
    },
    provider: new ScriptedModelProvider({ chunks: ["Hello", " world"] }),
  });

  expect(handled).toBe(true);
  expect(updates).toEqual(["Hello world"]);
});

test("a scripted prompt edits a project file and records the tool event", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-turn-"));
  const events: string[] = [];
  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "create result", projectPath: root, threadId: "thread" }),
      completeAssistantMessage: async () => undefined,
      recordToolCompleted: async ({ summary }) => { events.push(summary); },
    },
    provider: new ScriptedModelProvider({ chunks: ["Done"], toolCalls: [{ content: "agent edit", kind: "edit", path: "result.txt" }] }),
  });
  expect(await readFile(join(root, "result.txt"), "utf8")).toBe("agent edit");
  expect(events).toEqual(["Edited result.txt"]);
});
