import { expect, test, describe } from "bun:test";
import { buildHistory, resumeHistory } from "./history-projection";
import type { CanonicalEvent } from "@relay/contracts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ev(type: string, seq = 1, payload: Record<string, any> = {}): CanonicalEvent {
  return {
    eventId: `ev-${type}-${seq}`,
    sequence: seq,
    streamVersion: 1,
    type,
    runId: "run-1",
    correlationId: "corr-1",
    occurredAt: Date.now(),
    payload,
  } as unknown as CanonicalEvent;
}

describe("buildHistory", () => {
  test("empty events produce empty snapshot", () => {
    const snap = buildHistory("run-1", []);
    expect(snap.items).toHaveLength(0);
    expect(snap.throughSequence).toBe(0);
  });

  test("turn.started produces a user_message item", () => {
    const events = [ev("turn.started", 1, { prompt: "hello world" })];
    const snap = buildHistory("run-1", events);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0]!.kind).toBe("user_message");
    expect((snap.items[0] as { content: string }).content).toBe("hello world");
    expect(snap.throughSequence).toBe(1);
  });

  test("assistant.delta produces an assistant_text item", () => {
    const events = [
      ev("turn.started", 1, { prompt: "hi" }),
      ev("assistant.delta", 2, { text: "Hello!" }),
    ];
    const snap = buildHistory("run-1", events);
    const texts = snap.items.filter((i) => i.kind === "assistant_text");
    expect(texts).toHaveLength(1);
    expect((texts[0] as { text: string }).text).toBe("Hello!");
  });

  test("consecutive assistant.delta events merge into one text block", () => {
    const events = [
      ev("turn.started", 1, { prompt: "x" }),
      ev("assistant.delta", 2, { text: "Hello " }),
      ev("assistant.delta", 3, { text: "World" }),
    ];
    const snap = buildHistory("run-1", events);
    const texts = snap.items.filter((i) => i.kind === "assistant_text");
    expect(texts).toHaveLength(1);
    expect((texts[0] as { text: string }).text).toBe("Hello World");
  });

  test("deterministic: same events produce identical snapshot", () => {
    const events = [
      ev("turn.started", 1, { prompt: "a" }),
      ev("assistant.delta", 2, { text: "b" }),
      ev("activity.completed", 3, { activityId: "a1", summary: "did work", toolName: "bash" }),
      ev("approval.resolved", 4, { approvalId: "appr1", resolution: "allow" }),
    ];

    const s1 = buildHistory("run-1", events);
    const s2 = buildHistory("run-1", events);
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
  });

  test("checkpoint captured produces a checkpoint item", () => {
    const events = [
      ev("checkpoint.captured", 1, { checkpointId: "ck1", commit: "abc123", ref: "refs/relay/ckpt/1" }),
    ];
    const snap = buildHistory("run-1", events);
    const ck = snap.items.find((i) => i.kind === "checkpoint");
    expect(ck).toBeDefined();
  });

  test("activity.failed produces an activity_summary with error", () => {
    const events = [
      ev("activity.failed", 1, { activityId: "a1", error: "something broke" }),
    ];
    const snap = buildHistory("run-1", events);
    const item = snap.items[0];
    expect(item?.kind).toBe("activity_summary");
    expect((item as { summary: string }).summary).toContain("Failed");
  });
});

describe("resumeHistory", () => {
  test("applies only new events past throughSequence", () => {
    const initial = buildHistory("run-1", [
      ev("turn.started", 1, { prompt: "first" }),
    ]);
    expect(initial.throughSequence).toBe(1);

    const resumed = resumeHistory(initial, [
      ev("turn.started", 1, { prompt: "first" }),
      ev("turn.started", 2, { prompt: "second" }),
    ]);

    expect(resumed.items).toHaveLength(2);
    expect(resumed.throughSequence).toBe(2);
  });

  test("resume with no new events returns identical snapshot", () => {
    const initial = buildHistory("run-1", [
      ev("turn.started", 1, { prompt: "x" }),
    ]);
    const resumed = resumeHistory(initial, []);
    expect(resumed.items).toHaveLength(1);
    expect(resumed.throughSequence).toBe(1);
  });
});
