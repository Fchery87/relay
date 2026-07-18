import { expect, test } from "bun:test";
import { TOOL_DESCRIPTIONS, getToolDescription } from "./tool-descriptions";

// Must match the keys in TOOL_PARAMETERS from model-router.ts
const EXPECTED_TOOLS = ["bash", "edit", "read", "task", "web_search", "web_fetch"];

test("every tool in TOOL_PARAMETERS has a description", () => {
  for (const name of EXPECTED_TOOLS) {
    expect(TOOL_DESCRIPTIONS[name], `Missing description for ${name}`).toBeDefined();
  }
});

test("every description is at least 200 characters", () => {
  for (const [name, description] of Object.entries(TOOL_DESCRIPTIONS)) {
    expect(description.length, `${name} description too short`).toBeGreaterThanOrEqual(200);
  }
});

test("getToolDescription returns real descriptions for known tools", () => {
  expect(getToolDescription("bash").length).toBeGreaterThanOrEqual(200);
  expect(getToolDescription("read").length).toBeGreaterThanOrEqual(200);
  expect(getToolDescription("edit").length).toBeGreaterThanOrEqual(200);
  expect(getToolDescription("task").length).toBeGreaterThanOrEqual(200);
});

test("getToolDescription falls back for unknown tools", () => {
  expect(getToolDescription("nonexistent")).toBe("Relay nonexistent tool");
});
