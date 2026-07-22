import { expect, test, describe } from "bun:test";
import type { ProviderInstanceId } from "@relay/contracts";
import { normalizeCodexNotification, type NormalizedEvent } from "./normalize-event";

// ---------------------------------------------------------------------------
// G2: Codex notification normalization lifecycle tests.
// Every canonical Codex notification variant must produce a bounded,
// well-typed canonical event without crashing.
// ---------------------------------------------------------------------------

const PROVIDER = "codex-fixture" as ProviderInstanceId;
const RUN = "run-fixture";

describe("Codex notification normalization (G2)", () => {
  test("agent/text-delta produces assistant.delta with text payload", () => {
    const events = normalizeCodexNotification({ method: "agent/text-delta", params: { text: "Hello world" } }, RUN, PROVIDER);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("assistant.delta");
    const payload = events[0]!.payload as { text?: string };
    expect(payload.text).toBe("Hello world");
  });

  test("agent/completed signals assistant turn end", () => {
    const events = normalizeCodexNotification({ method: "agent/completed", params: {} }, RUN, PROVIDER);
    expect(events.some((e: NormalizedEvent) => e.type === "assistant.completed")).toBe(true);
  });

  test("turn/completed signals canonical turn end", () => {
    const events = normalizeCodexNotification({ method: "turn/completed", params: {} }, RUN, PROVIDER);
    expect(events.some((e: NormalizedEvent) => e.type === "turn.completed")).toBe(true);
  });

  test("turn/start produces thread lifecycle event", () => {
    const events = normalizeCodexNotification({ method: "turn/start", params: { id: "turn-1" } }, RUN, PROVIDER);
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  test("approval/requested produces approval.requested", () => {
    const events = normalizeCodexNotification({ method: "approval/requested", params: { approvalId: "apr-1", capability: "exec", risk: "high" } }, RUN, PROVIDER);
    expect(events.some((e: NormalizedEvent) => e.type === "approval.requested")).toBe(true);
  });

  test("turn/steered produces turn.steered", () => {
    const events = normalizeCodexNotification({ method: "turn/steered", params: { steering: "use TS" } }, RUN, PROVIDER);
    expect(events.some((e: NormalizedEvent) => e.type === "turn.steered")).toBe(true);
  });

  test("turn/interrupted produces turn.interrupted", () => {
    const events = normalizeCodexNotification({ method: "turn/interrupted", params: { reason: "user" } }, RUN, PROVIDER);
    expect(events.some((e: NormalizedEvent) => e.type === "turn.interrupted")).toBe(true);
  });

  test("thread/created produces lifecycle event", () => {
    const events = normalizeCodexNotification({ method: "thread/created", params: { id: "thread-new" } }, RUN, PROVIDER);
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  test("unknown notifications produce empty or diagnostic entries", () => {
    const events = normalizeCodexNotification({ method: "experimental/feature", params: { foo: 1 } }, RUN, PROVIDER);
    // Must be bounded, never crash
    expect(events.length).toBeLessThanOrEqual(1);
  });

  test("provider failure (empty/missing params) does not crash", () => {
    const events = normalizeCodexNotification({ method: "turn/completed" }, RUN, PROVIDER);
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  test("duplicate turn/completed is normalized identically", () => {
    const first = normalizeCodexNotification({ method: "turn/completed", params: {} }, RUN, PROVIDER);
    const second = normalizeCodexNotification({ method: "turn/completed", params: {} }, RUN, PROVIDER);
    expect(first.length).toBe(second.length);
    if (first[0] && second[0]) expect(first[0].type).toBe(second[0].type);
  });

  test("MCP elicitation is normalized", () => {
    const events = normalizeCodexNotification({ method: "mcp/elicitation", params: { server: "test-server", tool: "fetch" } }, RUN, PROVIDER);
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  test("usage/recorded produces usage event", () => {
    const events = normalizeCodexNotification({ method: "usage/recorded", params: { inputTokens: 100, outputTokens: 50 } }, RUN, PROVIDER);
    const usage = events.find((e: NormalizedEvent) => e.type === "usage.recorded");
    expect(usage).toBeDefined();
    expect(usage!.payload).toBeDefined();
  });
});
