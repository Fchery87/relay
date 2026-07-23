import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowEffectFence } from "@relay/orchestration";
import { ShadowRuntime } from "./shadow-runtime";

async function withEvidence(testBody: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "relay-shadow-"));
  try {
    await testBody(join(root, "evidence.jsonl"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function captureTurn(runtime: ShadowRuntime, text: string, runId = "run-shadow-1"): void {
  runtime.beginLegacyTurn({ projectId: "project-shadow-1", prompt: "say hello", runId });
  runtime.recordLegacyEffect({ effectId: `message:msg-${runId}`, kind: "assistant.message", runId });
  runtime.recordLegacyAssistantText({ messageId: `msg-${runId}`, runId, text });
}

describe("ShadowRuntime", () => {
  test("captures legacy-owned effects, compares a deterministic no-op kernel, and persists evidence", async () => {
    await withEvidence(async (evidencePath) => {
      const runtime = new ShadowRuntime({ evidencePath, tickIntervalMs: 1_000 });
      await runtime.start();
      expect(runtime.active).toBe(true);
      await runtime.start(); // duplicate start must not add a second timer

      captureTurn(runtime, "hello");
      const comparison = await runtime.finishLegacyTurn({ messageId: "msg-run-shadow-1", runId: "run-shadow-1" });

      expect(comparison?.report.ok).toBe(true);
      expect(runtime.promotionBlocked()).toBe(false);
      expect(runtime.effects).toHaveLength(2);
      expect((await readFile(evidencePath, "utf8")).trim().split("\n")).toHaveLength(1);

      runtime.stop();
      expect(runtime.active).toBe(false);

      const reopened = new ShadowRuntime({ evidencePath });
      await reopened.start();
      expect(reopened.evidence).toHaveLength(1);
      expect(reopened.promotionBlocked()).toBe(false);
      reopened.stop();
    });
  });

  test("persists unexplained divergence and blocks promotion", async () => {
    await withEvidence(async (evidencePath) => {
      const runtime = new ShadowRuntime({ evidencePath, kernelText: "different" });
      await runtime.start();
      captureTurn(runtime, "hello", "run-shadow-divergence");

      const comparison = await runtime.finishLegacyTurn({ messageId: "msg-run-shadow-divergence", runId: "run-shadow-divergence" });
      expect(comparison?.report.ok).toBe(false);
      expect(runtime.promotionBlocked()).toBe(true);
      runtime.stop();

      const reopened = new ShadowRuntime({ evidencePath });
      await reopened.start();
      expect(reopened.promotionBlocked()).toBe(true);
      expect(reopened.evidence[0]?.parityReport.divergences.some((entry) => entry.includes("assistant.delta"))).toBe(true);
      reopened.stop();
    });
  });

  test("captures the real legacy gateway turn boundary before comparing", async () => {
    await withEvidence(async (evidencePath) => {
      const runtime = new ShadowRuntime({ evidencePath });
      await runtime.start();
      const gateway = runtime.wrapConversationGateway({
        claimQueuedMessage: async () => ({ content: "say hello", projectId: "project-shadow-2", projectPath: "/tmp/project", threadId: "run-shadow-gateway" }),
        beginAssistantMessage: async () => "msg-run-shadow-gateway",
        appendAssistantText: async () => undefined,
        completeAssistantMessage: async () => undefined,
      } as unknown as import("../agent-loop").ConversationGateway);

      await gateway.claimQueuedMessage({ deviceToken: "device" });
      await gateway.beginAssistantMessage({ threadId: "run-shadow-gateway" });
      await gateway.appendAssistantText({ content: "hello", messageId: "msg-run-shadow-gateway" });
      await gateway.completeAssistantMessage({ messageId: "msg-run-shadow-gateway", threadId: "run-shadow-gateway" });

      expect(runtime.evidence).toHaveLength(1);
      expect(runtime.evidence[0]?.parityReport.ok).toBe(true);
      runtime.stop();
    });
  });

  test("rejects shadow-owned effects and accepts exact legacy replay", async () => {
    await withEvidence(async (evidencePath) => {
      const runtime = new ShadowRuntime({ evidencePath });
      await runtime.start();
      const fence = new ShadowEffectFence();
      expect(() => fence.record({ effectId: "effect-1", kind: "provider.send_turn", owner: "shadow" })).toThrow("legacy-owned");
      expect(() => fence.record({ effectId: "effect-1", kind: "provider.send_turn", owner: "legacy" })).not.toThrow();
      expect(() => fence.record({ effectId: "effect-1", kind: "provider.send_turn", owner: "legacy" })).not.toThrow();
      runtime.stop();
    });
  });
});
