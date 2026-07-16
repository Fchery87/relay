import { expect, test, describe } from "bun:test";
import { buildContext, type ContextPolicy } from "./context-manager";
import type { HistorySnapshot, CanonicalHistoryItem } from "@relay/contracts";

const defaultPolicy: ContextPolicy = {
  maxTokens: 1000,
  compactToTokens: 400,
  preserveRecentTurns: 10,
  pinned: {},
};

function snap(
  items: ReadonlyArray<CanonicalHistoryItem>,
  throughSequence = items.length,
): HistorySnapshot {
  return {
    runId: "run-1" as never,
    items,
    throughSequence,
    createdAt: Date.now(),
  };
}

function userMsg(content: string, sequence = 1): CanonicalHistoryItem {
  return {
    kind: "user_message",
    id: `u-${sequence}`,
    content,
    turnId: `t-${sequence}` as never,
    createdAt: Date.now(),
    provenance: { eventSequences: [sequence], correlationId: "c1" },
  };
}

function asstText(text: string, sequence = 2): CanonicalHistoryItem {
  return {
    kind: "assistant_text",
    id: `a-${sequence}`,
    text,
    turnId: `t-${sequence - 1}` as never,
    createdAt: Date.now(),
    provenance: { eventSequences: [sequence], correlationId: "c1" },
  };
}

function toolSummary(summary: string, sequence = 3): CanonicalHistoryItem {
  return {
    kind: "activity_summary",
    id: `act-${sequence}`,
    activityId: `aid-${sequence}` as never,
    toolName: "bash",
    summary,
    turnId: `t-${sequence}` as never,
    createdAt: Date.now(),
    provenance: { eventSequences: [sequence], correlationId: "c1" },
  };
}

describe("buildContext", () => {
  test("no compaction for small history", () => {
    const ctx = buildContext(
      snap([userMsg("hello"), asstText("hi there")]),
      defaultPolicy,
    );
    expect(ctx.compacted).toBe(false);
    expect(ctx.estimatedTokens).toBeLessThan(defaultPolicy.maxTokens);
    expect(ctx.prompt).toContain("hello");
    expect(ctx.prompt).toContain("hi there");
  });

  test("triggers compaction when budget is exceeded", () => {
    const long = "x".repeat(4000); // ~1000 tokens, exceeds 80% of 1000
    const ctx = buildContext(
      snap([userMsg(long)]),
      defaultPolicy,
    );
    expect(ctx.compacted).toBe(true);
    expect(ctx.prompt).not.toContain(long);
  });

  test("preserves pinned invariants", () => {
    const policy: ContextPolicy = {
      ...defaultPolicy,
      pinned: {
        systemPrompt: "You are a helpful assistant.",
        activePlan: "Step 1: build. Step 2: test.",
      },
    };
    const ctx = buildContext(snap([userMsg("hello"), asstText("hi")]), policy);
    expect(ctx.prompt).toContain("You are a helpful assistant.");
    expect(ctx.prompt).toContain("Step 1: build");
  });

  test("includes unresolved review comments", () => {
    const policy: ContextPolicy = {
      ...defaultPolicy,
      pinned: {
        unresolvedComments: ["Fix the null check on line 42", "Add error boundary"],
      },
    };
    const ctx = buildContext(snap([userMsg("ok")]), policy);
    expect(ctx.prompt).toContain("Fix the null check on line 42");
    expect(ctx.prompt).toContain("Add error boundary");
  });

  test("compacted context produces a compaction_artifact", () => {
    const long = "x".repeat(5000);
    const ctx = buildContext(
      snap([userMsg(long), asstText("short")]),
      defaultPolicy,
    );
    expect(ctx.compacted).toBe(true);
    expect(ctx.compactionArtifact).toBeDefined();
    expect(ctx.compactionArtifact?.kind).toBe("compaction_artifact");
    expect(ctx.compactionArtifact?.summary).toContain("Compacted");
  });

  test("multiple turns are counted correctly in compaction summary", () => {
    const long = "x".repeat(600);
    const items = Array.from({ length: 20 }, (_, i) =>
      userMsg(long + i, i + 1),
    );
    const ctx = buildContext(snap(items), defaultPolicy);
    expect(ctx.compacted).toBe(true);
    if (ctx.compactionArtifact) {
      expect(ctx.compactionArtifact.turnCount).toBeGreaterThan(0);
    }
  });
});
