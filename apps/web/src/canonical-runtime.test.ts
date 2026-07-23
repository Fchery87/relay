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
