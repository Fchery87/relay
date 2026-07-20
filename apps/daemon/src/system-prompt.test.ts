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

test("announces the planning phase with read-only guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-system-prompt-"));
  const prompt = await buildSystemPrompt({ planPhase: "planning", platform: "linux", root });
  expect(prompt).toContain("PLAN MODE — PLANNING PHASE");
  expect(prompt).toContain("refused in this phase");
  expect(prompt).not.toContain("BUILDING PHASE");
});

test("announces the building phase and omits plan blocks outside plan mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-system-prompt-"));
  const building = await buildSystemPrompt({ planPhase: "building", platform: "linux", root });
  expect(building).toContain("PLAN MODE — BUILDING PHASE");
  const plain = await buildSystemPrompt({ platform: "linux", root });
  expect(plain).not.toContain("PLAN MODE");
});

test("lists subagent roles with exact names", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-system-prompt-"));
  const prompt = await buildSystemPrompt({ platform: "linux", root, subagentRoles: [{ description: "Map the codebase.", name: "explore" }, { description: "Implement a change.", name: "build" }] });
  expect(prompt).toContain("AVAILABLE SUBAGENT ROLES");
  expect(prompt).toContain("- explore: Map the codebase.");
  expect(prompt).toContain("- build: Implement a change.");
});
