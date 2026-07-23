import { expect, test } from "bun:test";
import { createCanonicalRuntime, projectionEventsToCheckpointComparison, projectionEventsToCheckpoints, projectionEventsToDiff, projectionEventsToGitActions, projectionEventsToMcpElicitations, projectionEventsToMessages, projectionEventsToReviewComments, projectionEventsToSlashCommands, projectionEventsToSubagentRuns, projectionEventsToUsage } from "./canonical-runtime";
import { canonicalCommandEnvelope, canonicalCommandId, resolveRunData } from "./run-data";

test("the run-data boundary switches between projection and legacy rollback explicitly", () => {
  expect(resolveRunData(true).source).toBe("projection");
  expect(resolveRunData(true).getRunSnapshot).toBeDefined();
  expect(resolveRunData(false).source).toBe("legacy");
});

test("canonical web runtime is backed by client runtime", () => {
  const runtime = createCanonicalRuntime({
    fetchSnapshot: async () => undefined,
    fetchEvents: async () => [],
    submitCommand: async () => { throw new Error("not used"); },
  });
  expect(runtime).toBeDefined();
});

test("canonical commands have stable IDs and immutable envelopes", () => {
  const first = canonicalCommandEnvelope({ kind: "turn.send", payload: { prompt: "hello" }, runId: "run-1", threadId: "run-1" });
  const retry = canonicalCommandEnvelope({ kind: "turn.send", payload: { prompt: "hello" }, runId: "run-1", threadId: "run-1" });
  const changed = canonicalCommandEnvelope({ kind: "turn.send", payload: { prompt: "different" }, runId: "run-1", threadId: "run-1" });
  expect(first.commandId).toBe(retry.commandId);
  expect(first.payloadJson).toBe(retry.payloadJson);
  expect(changed.commandId).not.toBe(first.commandId);
  expect(canonicalCommandId("run-1", "turn.send", { prompt: "hello" })).toBe(first.commandId);
});

test("core browser actions all use the canonical command vocabulary", () => {
  const commands = [
    ["run.create", { projectId: "project-1" }],
    ["turn.send", { prompt: "hello" }],
    ["approval.resolve", { approvalId: "approval-1", resolution: "deny" }],
    ["run.stop", { reason: "user" }],
    ["checkpoint.restore", { checkpointId: "checkpoint-1" }],
    ["checkpoint.compare", { fromCheckpointId: "checkpoint-1", fromCommit: "abc", toCheckpointId: "checkpoint-2", toCommit: "def" }],
    ["git.action", { action: "stage" }],
    ["run.configure", { modelId: "test-model", thinkingLevel: "low", permissionProfile: "workspace-write", budgetUsd: 5 }],
  ] as const;
  const envelopes = commands.map(([kind, payload]) => canonicalCommandEnvelope({ kind, payload, runId: "run-1", threadId: "run-1" }));
  expect(envelopes.map((envelope) => envelope.kind)).toEqual(commands.map(([kind]) => kind));
  expect(new Set(envelopes.map((envelope) => envelope.commandId)).size).toBe(commands.length);
  expect(envelopes.every((envelope) => envelope.correlationId.startsWith("corr-cmd-"))).toBe(true);
});

test("canonical event tails project ordered user and assistant messages", () => {
  const event = (sequence: number, type: string, payload: Record<string, unknown>) => ({
    eventId: `event-${sequence}` as never,
    sequence,
    streamVersion: sequence,
    type: type as never,
    runId: "run-1" as never,
    turnId: "turn-1" as never,
    correlationId: "corr-1" as never,
    occurredAt: sequence,
    payload,
  });
  const messages = projectionEventsToMessages([
    event(3, "assistant.delta", { text: "world" }),
    event(1, "turn.started", { prompt: "say hello" }),
    event(4, "assistant.completed", {}),
    event(2, "assistant.delta", { text: "hello " }),
  ]);
  expect(messages).toEqual([
    { _id: "user:turn-1", content: "say hello", role: "user", status: "complete" },
    { _id: "assistant:turn-1", content: "hello world", role: "assistant", status: "complete" },
  ]);
});

test("canonical checkpoint artifacts retain restore metadata and comparison output", () => {
  const event = (sequence: number, type: string, payload: Record<string, unknown>) => ({
    eventId: `event-${sequence}` as never,
    sequence,
    streamVersion: sequence,
    type: type as never,
    runId: "run-1" as never,
    turnId: "turn-1" as never,
    correlationId: "corr-1" as never,
    occurredAt: sequence,
    payload,
  });
  expect(projectionEventsToCheckpoints([event(1, "checkpoint.captured", { checkpointId: "checkpoint-1", commit: "abc", ref: "refs/relay/checkpoints/run-1/turn-1" })])).toEqual([{
    _id: "checkpoint-1",
    commit: "abc",
    messageId: "turn-1",
    ref: "refs/relay/checkpoints/run-1/turn-1",
  }]);
  expect(projectionEventsToCheckpointComparison([event(2, "checkpoint.compared", { content: "diff", fromCheckpointId: "abc", toCheckpointId: "def" })])).toEqual({ _id: "comparison:abc:def", content: "diff", status: "complete" });
  expect(projectionEventsToDiff([event(3, "workspace.diff.updated", { baseCommit: "HEAD", content: "current diff" })])).toBe("current diff");
});

test("canonical event tails project review comments and resolve only matching comments", () => {
  const event = (sequence: number, type: string, payload: Record<string, unknown>) => ({
    eventId: `event-${sequence}` as never,
    sequence,
    streamVersion: sequence,
    type: type as never,
    runId: "run-1" as never,
    correlationId: "corr-1" as never,
    occurredAt: sequence,
    payload,
  });
  expect(projectionEventsToReviewComments([
    event(3, "review.comment.resolved", { commentId: "comment-1" }),
    event(1, "review.comment.created", { commentId: "comment-1", content: "Fix this", endLine: 4, filePath: "src/app.ts", startLine: 3 }),
    event(2, "review.comment.created", { commentId: "comment-2", content: "Also this", endLine: 8, filePath: "src/app.ts", startLine: 8 }),
  ])).toEqual([
    { _id: "comment-1", content: "Fix this", endLine: 4, filePath: "src/app.ts", resolved: true, startLine: 3 },
    { _id: "comment-2", content: "Also this", endLine: 8, filePath: "src/app.ts", resolved: false, startLine: 8 },
  ]);
});

test("canonical runtime behavior covers create, turn, approval, stop, checkpoint, and reconnect", async () => {
  const submitted: string[] = [];
  let sequence = 0;
  const runtime = createCanonicalRuntime({
    fetchSnapshot: async () => ({ runId: "run-1" as never, status: "running", sequence, streamVersion: sequence, restartCount: 0, createdAt: 1, updatedAt: 1 }),
    fetchEvents: async () => [],
    submitCommand: async (command) => {
      submitted.push(command.kind);
      sequence += 1;
      return { runId: "run-1" as never, status: "running", sequence, streamVersion: sequence, restartCount: 0, createdAt: 1, updatedAt: sequence };
    },
  });

  await runtime.connect("run-1");
  await runtime.submit("run-1", "run.create", { projectId: "project-1" });
  await runtime.submit("run-1", "turn.send", { prompt: "hello" });
  await runtime.submit("run-1", "approval.resolve", { approvalId: "approval-1", resolution: "allow" });
  await runtime.submit("run-1", "run.stop", { reason: "user" });
  await runtime.submit("run-1", "checkpoint.restore", { checkpointId: "checkpoint-1" });
  await runtime.resume("run-1");

  expect(submitted).toEqual(["run.create", "turn.send", "approval.resolve", "run.stop", "checkpoint.restore"]);
  expect(runtime.get("run-1")?.cursor).toBe(5);
});

test("canonical event tails project Git action lifecycle", () => {
  const event = (sequence: number, status: string) => ({
    eventId: `event-${sequence}` as never,
    sequence,
    streamVersion: sequence,
    type: "git.action.updated" as never,
    runId: "run-1" as never,
    correlationId: "corr-1" as never,
    occurredAt: sequence,
    payload: { action: "commit", actionId: "git-1", status },
  });
  expect(projectionEventsToGitActions([event(1, "running"), event(2, "complete")])).toEqual([{ _id: "git-1", action: "commit", status: "complete" }]);
});

test("canonical event tails project the durable usage budget", () => {
  const event = {
    eventId: "event-1" as never,
    sequence: 1,
    streamVersion: 1,
    type: "usage.recorded" as never,
    runId: "run-1" as never,
    correlationId: "corr-1" as never,
    occurredAt: 1,
    payload: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 2, modelId: "test", outputTokens: 3, thinkingTokens: 1 },
  };
  expect(projectionEventsToUsage([event], 7).budgetUsd).toBe(7);
});

test("canonical activity tails project subagent runs without legacy reads", () => {
  const event = (sequence: number, type: string, payload: Record<string, unknown>) => ({
    eventId: `event-${sequence}` as never,
    sequence,
    streamVersion: sequence,
    type: type as never,
    runId: "run-1" as never,
    turnId: "turn-1" as never,
    correlationId: "corr-1" as never,
    occurredAt: sequence,
    payload,
  });
  expect(projectionEventsToSubagentRuns([
    event(3, "activity.completed", { activityId: "subagent-1", kind: "subagent:explore", summary: "Mapped the repository" }),
    event(1, "activity.started", { activityId: "subagent-1", kind: "subagent:explore", task: "Inspect the repository" }),
  ])).toEqual([{
    _id: "subagent-1",
    capabilities: [],
    depth: 1,
    result: { artifacts: [], findings: [], status: "success", summary: "Mapped the repository" },
    roleId: "explore",
    status: "complete",
    task: "Inspect the repository",
  }]);
});

test("canonical activity tails project MCP elicitation cards without legacy reads", () => {
  const event = (sequence: number, type: string, payload: Record<string, unknown>) => ({
    eventId: `event-${sequence}` as never,
    sequence,
    streamVersion: sequence,
    type: type as never,
    runId: "run-1" as never,
    turnId: "turn-1" as never,
    correlationId: "corr-1" as never,
    occurredAt: sequence,
    payload,
  });
  expect(projectionEventsToMcpElicitations([
    event(3, "activity.completed", { activityId: "elicitation-activity", elicitationId: "elicitation-1", kind: "mcp:elicitation", summary: "Response submitted" }),
    event(1, "activity.started", { activityId: "elicitation-activity", elicitationId: "elicitation-1", kind: "mcp:elicitation", promptsJson: '[{"id":"date"}]', serverId: "travel", toolName: "book" }),
  ])).toEqual([{ _id: "elicitation-1", promptsJson: '[{"id":"date"}]', serverId: "travel", status: "submitted", toolName: "book" }]);
  expect(projectionEventsToMcpElicitations([
    event(1, "activity.started", { activityId: "cancelled-activity", elicitationId: "elicitation-2", kind: "mcp:elicitation", promptsJson: "[]", serverId: "travel", toolName: "book" }),
    event(2, "activity.failed", { activityId: "cancelled-activity", elicitationId: "elicitation-2", error: "MCP elicitation was cancelled", kind: "mcp:elicitation" }),
  ])).toEqual([{ _id: "elicitation-2", promptsJson: "[]", serverId: "travel", status: "cancelled", toolName: "book" }]);
});

test("canonical configuration tails project a bounded slash catalog without legacy reads", () => {
  const event = (sequence: number, payload: Record<string, unknown>) => ({
    eventId: `event-${sequence}` as never,
    sequence,
    streamVersion: sequence,
    type: "run.configuration.updated" as never,
    runId: "run-1" as never,
    correlationId: "corr-1" as never,
    occurredAt: sequence,
    payload,
  });
  expect(projectionEventsToSlashCommands([event(1, {
    slashCommands: [
      { description: "Ship changes", name: "ship", scope: "builtin" },
      { description: "Inspect", name: "inspect", scope: "project", projectPath: "/repo" },
      { description: "ignore malformed", name: 7, scope: "user" },
    ],
  })])).toEqual([
    { description: "Ship changes", name: "ship", scope: "builtin" },
    { description: "Inspect", name: "inspect", projectPath: "/repo", scope: "project" },
  ]);
});
