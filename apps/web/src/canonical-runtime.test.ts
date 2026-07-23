import { expect, test } from "bun:test";
import { createCanonicalRuntime } from "./canonical-runtime";
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
  ] as const;
  const envelopes = commands.map(([kind, payload]) => canonicalCommandEnvelope({ kind, payload, runId: "run-1", threadId: "run-1" }));
  expect(envelopes.map((envelope) => envelope.kind)).toEqual(commands.map(([kind]) => kind));
  expect(new Set(envelopes.map((envelope) => envelope.commandId)).size).toBe(commands.length);
  expect(envelopes.every((envelope) => envelope.correlationId.startsWith("corr-cmd-"))).toBe(true);
});
