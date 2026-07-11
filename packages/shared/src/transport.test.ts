import { expect, test } from "bun:test";

import { approvalResolutionSchema, queuedCommandSchema, queuedMessageSchema } from "./transport";

test("validates untrusted Convex work queue documents", () => {
  expect(queuedCommandSchema.parse({ command: "pwd", commandId: "command", projectPath: "/repo", threadId: "thread" })).toMatchObject({ command: "pwd" });
  expect(queuedMessageSchema.parse({ content: "hello", modelId: "deepseek/chat", projectPath: "/repo", reviewComments: [], thinkingLevel: "none", threadId: "thread" })).toMatchObject({ content: "hello" });
  expect(approvalResolutionSchema.parse({ decision: "deny" })).toEqual({ decision: "deny" });
});

test("rejects malformed Convex work queue documents", () => {
  expect(() => queuedCommandSchema.parse({ command: "", commandId: "", projectPath: "", threadId: "" })).toThrow();
  expect(() => queuedMessageSchema.parse({ content: 42, modelId: "deepseek/chat", projectPath: "/repo", reviewComments: [], thinkingLevel: "none", threadId: "thread" })).toThrow();
  expect(() => approvalResolutionSchema.parse({ decision: "pending", unexpected: true })).not.toThrow();
  expect(() => approvalResolutionSchema.parse({ decision: "maybe" })).toThrow();
});
