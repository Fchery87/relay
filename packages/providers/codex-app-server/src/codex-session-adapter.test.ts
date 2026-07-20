import { expect, test, describe } from "bun:test";
import { normalizeCodexNotification, sanitizeProjectionPayload } from "./normalize-event";

// ---------------------------------------------------------------------------
// Session adapter tests — use the deterministic normalizer with mock events
// ---------------------------------------------------------------------------

describe("Codex session adapter integration", () => {
  test("normalizes thread/created and turn/started into canonical session lifecycle", () => {
    const created = normalizeCodexNotification(
      { method: "thread/created", params: { threadId: "thr_abc" } },
      "run-1",
      "codex" as never,
    );
    const started = normalizeCodexNotification(
      { method: "turn/started", params: { prompt: "Build a web app" } },
      "run-1",
      "codex" as never,
    );

    expect(created.some((e) => e.type === "provider.session.started")).toBe(true);
    expect(created.some((e) => e.type === "run.started")).toBe(true);
    expect(started.some((e) => e.type === "turn.started")).toBe(true);
  });

  test("normalizes agent/text-delta into assistant.delta with bounded text", () => {
    const result = normalizeCodexNotification(
      { method: "agent/text-delta", params: { text: "Hello world" } },
      "run-1",
      "codex" as never,
    );
    expect(result[0]!.type).toBe("assistant.delta");
    expect((result[0]!.payload as { text: string }).text).toBe("Hello world");
  });

  test("normalizes turn/completed and thread/stopped into terminal events", () => {
    const completed = normalizeCodexNotification(
      { method: "turn/completed", params: { summary: "Done" } },
      "run-1",
      "codex" as never,
    );
    const stopped = normalizeCodexNotification(
      { method: "thread/stopped" },
      "run-1",
      "codex" as never,
    );

    expect(completed.some((e) => e.type === "turn.completed")).toBe(true);
    expect(stopped.some((e) => e.type === "provider.session.stopped")).toBe(true);
  });

  test("normalizes activity/started, activity/delta, activity/completed into canonical activity events", () => {
    const started = normalizeCodexNotification(
      { method: "activity/started", params: { activityId: "act-1", kind: "bash", toolName: "bash" } },
      "run-1",
      "codex" as never,
    );
    const delta = normalizeCodexNotification(
      { method: "activity/delta", params: { activityId: "act-1", content: "npm install" } },
      "run-1",
      "codex" as never,
    );
    const completed = normalizeCodexNotification(
      { method: "activity/completed", params: { activityId: "act-1", summary: "Installed" } },
      "run-1",
      "codex" as never,
    );

    expect(started[0]!.type).toBe("activity.started");
    expect(delta[0]!.type).toBe("activity.delta");
    expect(completed[0]!.type).toBe("activity.completed");
  });

  test("normalizes usage/recorded with bounded token counts", () => {
    const result = normalizeCodexNotification(
      { method: "usage/recorded", params: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 50, modelId: "gpt-5.1-codex" } },
      "run-1",
      "codex" as never,
    );
    expect(result[0]!.type).toBe("usage.recorded");
  });

  test("projects all payloads through the bounded sanitizer", () => {
    const result = normalizeCodexNotification(
      { method: "agent/text-delta", params: { text: "a".repeat(100_000) } },
      "run-1",
      "codex" as never,
    );
    const sanitized = sanitizeProjectionPayload(result[0]!.payload);
    expect((sanitized.text as string).length).toBeLessThan(100_000);
  });

  test("unknown notification is ignored without fabricated activity", () => {
    const result = normalizeCodexNotification(
      { method: "some/future/notification" },
      "run-1",
      "codex" as never,
    );
    expect(result).toEqual([]);
  });

  test("round-trips approval requested + resolved", () => {
    const req = normalizeCodexNotification(
      { method: "approval/requested", params: { approvalId: "apr-1", capability: "exec", risk: "high", details: "rm -rf /" } },
      "run-1",
      "codex" as never,
    );
    const res = normalizeCodexNotification(
      { method: "approval/resolved", params: { approvalId: "apr-1", resolution: "deny" } },
      "run-1",
      "codex" as never,
    );
    expect(req[0]!.type).toBe("approval.requested");
    expect(res[0]!.type).toBe("approval.resolved");
  });
});
