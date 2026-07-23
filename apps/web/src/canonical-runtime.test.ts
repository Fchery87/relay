import { expect, test } from "bun:test";
import { createCanonicalRuntime, projectionEventsToCheckpointComparison, projectionEventsToCheckpoints, projectionEventsToMessages } from "./canonical-runtime";
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
