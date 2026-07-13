import { describe, expect, test } from "bun:test";

import { DEFAULT_SUBAGENT_ROLES, narrowCapabilities, subagentResultSchema } from "./subagents";

describe("subagent contracts", () => {
  test("ships the approved nine-role roster", () => {
    expect(DEFAULT_SUBAGENT_ROLES.map(({ name }) => name)).toEqual([
      "explore", "plan", "researcher", "oracle", "reviewer", "reviewer-security", "evaluator", "build", "worker",
    ]);
  });

  test("capabilities can only narrow and delegation stops at depth two", () => {
    expect(narrowCapabilities({ child: ["read", "task"], depth: 1, parent: ["read", "edit", "task"] })).toEqual(["read", "task"]);
    expect(() => narrowCapabilities({ child: ["exec"], depth: 1, parent: ["read", "task"] })).toThrow("cannot grant exec");
    expect(() => narrowCapabilities({ child: ["read"], depth: 3, parent: ["read", "task"] })).toThrow("depth");
  });

  test("validates the persisted result contract", () => {
    expect(subagentResultSchema.parse({ artifacts: [], findings: ["src/app.ts:1 exists"], status: "success", summary: "Mapped the app." })).toEqual({
      artifacts: [], findings: ["src/app.ts:1 exists"], status: "success", summary: "Mapped the app.",
    });
  });
});
