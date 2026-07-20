import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSystemPrompt } from "./system-prompt";

test("states the effective model id when one is provided", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-system-prompt-"));
  const prompt = await buildSystemPrompt({ modelId: "deepseek/deepseek-v4-flash", platform: "linux", root });
  expect(prompt).toContain("powered by the model `deepseek/deepseek-v4-flash`");
  expect(prompt).toContain("State this model id accurately");
});

test("omits model identity when no model id is provided", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-system-prompt-"));
  const prompt = await buildSystemPrompt({ platform: "linux", root });
  expect(prompt).not.toContain("powered by the model");
  expect(prompt).toContain("You are Relay, an agent running on the user's machine.");
});
