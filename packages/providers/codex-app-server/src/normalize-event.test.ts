import { expect, test, describe } from "bun:test";
import { normalizeCodexNotification } from "./normalize-event";

describe("normalizeCodexNotification", () => {
  test("thread/created produces provider.session.started and run.started", () => {
    const result = normalizeCodexNotification(
      { method: "thread/created", params: { threadId: "th-1" } },
      "run-1",
      "pi-1" as never,
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe("provider.session.started");
    expect(result[1]!.type).toBe("run.started");
  });

  test("turn/started produces turn.started with prompt", () => {
    const result = normalizeCodexNotification(
      { method: "turn/started", params: { prompt: "write code" } },
      "run-1",
      "pi-1" as never,
    );
    expect(result[0]!.type).toBe("turn.started");
    expect(result[0]!.payload.prompt).toBe("write code");
  });

  test("agent/text-delta produces assistant.delta", () => {
    const result = normalizeCodexNotification(
      { method: "agent/text-delta", params: { text: "Hello" } },
      "run-1",
      "pi-1" as never,
    );
    expect(result[0]!.type).toBe("assistant.delta");
  });

  test("turn/failed produces turn.failed", () => {
    const result = normalizeCodexNotification(
      { method: "turn/failed", params: { error: "timeout" } },
      "run-1",
      "pi-1" as never,
    );
    expect(result[0]!.type).toBe("turn.failed");
  });

  test("approval lifecycle round-trips", () => {
    const req = normalizeCodexNotification(
      { method: "approval/requested", params: { approvalId: "a1", capability: "exec", risk: "high", details: "rm -rf" } },
      "run-1",
      "pi-1" as never,
    );
    expect(req[0]!.type).toBe("approval.requested");

    const res = normalizeCodexNotification(
      { method: "approval/resolved", params: { approvalId: "a1", resolution: "deny" } },
      "run-1",
      "pi-1" as never,
    );
    expect(res[0]!.type).toBe("approval.resolved");
  });

  test("unknown notification produces diagnostic, never crashes", () => {
    const result = normalizeCodexNotification(
      { method: "some/unknown/event", params: {} },
      "run-1",
      "pi-1" as never,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("activity.delta");
    expect((result[0]!.payload as { content: string }).content).toContain("diag");
  });

  test("usage/recorded produces usage.recorded with token counts", () => {
    const result = normalizeCodexNotification(
      { method: "usage/recorded", params: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, thinkingTokens: 20, modelId: "gpt-4" } },
      "run-1",
      "pi-1" as never,
    );
    expect(result[0]!.type).toBe("usage.recorded");
  });
});
