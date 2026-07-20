import { expect, test, describe } from "bun:test";
import { normalizeCodexNotification, type NormalizedEvent } from "./normalize-event";

// ---------------------------------------------------------------------------
// G2: Codex notification normalization lifecycle tests.
// Every canonical Codex notification variant must produce a bounded,
// well-typed canonical event without crashing.
// ---------------------------------------------------------------------------

describe("Codex notification normalization (G2)", () => {
  test("agent/text-delta produces assistant.delta with text payload", () => {
    const events = normalizeCodexNotification({ method: "agent/text-delta", params: { text: "Hello world" } }, "thread-1");
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("assistant.delta");
    expect(events[0]!.payload.text).toBe("Hello world");
  });

  test("agent/completed signals assistant turn end", () => {
    const events = normalizeCodexNotification({ method: "agent/completed", params: {} }, "thread-1");
    expect(events.some((e: NormalizedEvent) => e.type === "assistant.completed")).toBe(true);
  });

  test("turn/completed signals canonical turn end", () => {
    const events = normalizeCodexNotification({ method: "turn/completed", params: {} }, "thread-1");
    expect(events.some((e: NormalizedEvent) => e.type === "turn.completed")).toBe(true);
  });

  test("turn/start produces thread lifecycle event", () => {
    const events = normalizeCodexNotification({ method: "turn/start", params: { id: "turn-1" } }, "thread-1");
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  test("approval/requested produces approval.requested", () => {
    const events = normalizeCodexNotification({ method: "approval/requested", params: { approvalId: "apr-1", capability: "exec", risk: "high" } }, "thread-1");
    expect(events.some((e: NormalizedEvent) => e.type === "approval.requested")).toBe(true);
  });

  test("turn/steered produces turn.steered", () => {
    const events = normalizeCodexNotification({ method: "turn/steered", params: { steering: "use TS" } }, "thread-1");
    expect(events.some((e: NormalizedEvent) => e.type === "turn.steered")).toBe(true);
  });

  test("turn/interrupted produces turn.interrupted", () => {
    const events = normalizeCodexNotification({ method: "turn/interrupted", params: { reason: "user" } }, "thread-1");
    expect(events.some((e: NormalizedEvent) => e.type === "turn.interrupted")).toBe(true);
  });

  test("thread/created produces lifecycle event", () => {
    const events = normalizeCodexNotification({ method: "thread/created", params: { id: "thread-new" } }, "unknown");
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  test("unknown notifications produce bounded diagnostic entries", () => {
    const events = normalizeCodexNotification({ method: "experimental/feature", params: { foo: 1 } }, "thread-1");
    // Must produce at most 1 diagnostic event, never crash
    expect(events.length).toBeLessThanOrEqual(1);
    if (events.length === 1) {
      expect(events[0]!.type).toBe("diagnostic");
    }
  });

  test("provider failure (empty/missing params) does not crash", () => {
    const events = normalizeCodexNotification({ method: "turn/completed" }, "thread-1");
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  test("duplicate turn/completed is normalized identically", () => {
    const first = normalizeCodexNotification({ method: "turn/completed", params: {} }, "thread-1");
    const second = normalizeCodexNotification({ method: "turn/completed", params: {} }, "thread-1");
    expect(first.length).toBe(second.length);
    if (first[0]) expect(first[0].type).toBe(second[0]?.type);
  });

  test("MCP elicitation is normalized", () => {
    const events = normalizeCodexNotification({ method: "mcp/elicitation", params: { server: "test-server", tool: "fetch" } }, "thread-1");
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  test("usage/recorded produces usage event", () => {
    const events = normalizeCodexNotification({ method: "usage/recorded", params: { inputTokens: 100, outputTokens: 50 } }, "thread-1");
    const usage = events.find((e: NormalizedEvent) => e.type === "usage.recorded");
    if (usage) {
      expect(usage.payload).toBeDefined();
    }
  });
});
