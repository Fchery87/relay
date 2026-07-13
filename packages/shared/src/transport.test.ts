import { expect, test } from "bun:test";

import { approvalResolutionSchema, queuedCommandSchema, queuedComparisonSchema, queuedMessageSchema, queuedRestoreSchema, steeringMessagesSchema, stopStateSchema } from "./transport";

test("validates untrusted Convex work queue documents", () => {
  expect(queuedCommandSchema.parse({ command: "pwd", commandId: "command", projectPath: "/repo", threadId: "thread" })).toMatchObject({ command: "pwd" });
  expect(queuedMessageSchema.parse({ content: "hello", modelId: "deepseek/chat", projectPath: "/repo", reviewComments: [], thinkingLevel: "none", threadId: "thread" })).toMatchObject({ content: "hello" });
  expect(approvalResolutionSchema.parse({ decision: "deny" })).toEqual({ decision: "deny" });
  expect(steeringMessagesSchema.parse([{ content: "change direction" }])).toEqual([{ content: "change direction" }]);
  expect(stopStateSchema.parse({ requested: true })).toEqual({ requested: true });
});

test("rejects malformed Convex work queue documents", () => {
  expect(() => queuedCommandSchema.parse({ command: "", commandId: "", projectPath: "", threadId: "" })).toThrow();
  expect(() => queuedMessageSchema.parse({ content: 42, modelId: "deepseek/chat", projectPath: "/repo", reviewComments: [], thinkingLevel: "none", threadId: "thread" })).toThrow();
  expect(() => approvalResolutionSchema.parse({ decision: "pending", unexpected: true })).not.toThrow();
  expect(() => approvalResolutionSchema.parse({ decision: "maybe" })).toThrow();
});

test("validates queued checkpoint restores", () => {
  expect(queuedRestoreSchema.parse({
    actionId: "action-1",
    claimToken: "claim-1",
    checkpointId: "checkpoint-1",
    commit: "abc123",
    projectPath: "/workspace/relay",
    threadId: "thread-1",
  })).toMatchObject({ commit: "abc123", threadId: "thread-1" });
  expect(() => queuedRestoreSchema.parse({ actionId: "", claimToken: "claim-1", checkpointId: "checkpoint-1", commit: "abc123", projectPath: "/workspace/relay", threadId: "thread-1" })).toThrow();
});

test("validates queued checkpoint comparisons", () => {
  expect(queuedComparisonSchema.parse({ claimToken: "claim-1", comparisonId: "comparison", fromCommit: "abc123", projectPath: "/repo", threadId: "thread", toCommit: "def456" })).toMatchObject({ comparisonId: "comparison" });
});
