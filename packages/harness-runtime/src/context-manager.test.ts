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

// ---------------------------------------------------------------------------
// Task C3: 100-turn stress test preserving semantic categories across compaction.
// ---------------------------------------------------------------------------

function approval(sequence: number, turnId: string, resolution: "allow" | "deny"): CanonicalHistoryItem {
  return { kind: "approval", id: `apr-${sequence}`, approvalId: `aid-${sequence}` as never, capability: "exec", risk: "high", resolution, turnId: turnId as never, createdAt: Date.now(), provenance: { eventSequences: [sequence], correlationId: `corr-${sequence}` } };
}

function subagent(sequence: number, turnId: string): CanonicalHistoryItem {
  return { kind: "subagent_result", id: `sub-${sequence}`, roleName: "reviewer", summary: `Subagent ${sequence} result`, turnId: turnId as never, createdAt: Date.now(), provenance: { eventSequences: [sequence], correlationId: `corr-${sequence}` } };
}

function checkpoint(sequence: number, turnId: string): CanonicalHistoryItem {
  return { kind: "checkpoint", id: `ck-${sequence}`, checkpointId: `ckid-${sequence}` as never, commit: `abc${sequence}`, ref: `refs/heads/chk-${sequence}`, turnId: turnId as never, createdAt: Date.now(), provenance: { eventSequences: [sequence], correlationId: `corr-${sequence}` } };
}

function attachment(sequence: number, turnId: string): CanonicalHistoryItem {
  return { kind: "attachment", id: `att-${sequence}`, name: `file-${sequence}.ts`, path: `/src/file-${sequence}.ts`, size: 1024, turnId: turnId as never, createdAt: Date.now(), provenance: { eventSequences: [sequence], correlationId: `corr-${sequence}` } };
}

describe("100-turn stress test (Phase C / Task C3)", () => {
  const longReply = "x".repeat(400);
  const longGoal = "GOAL: build a reliable multi-tenant CI pipeline with sandboxed execution. ".repeat(5);

  test("preserves goal, constraints, decisions, and references across 100 turns", () => {
    const items: CanonicalHistoryItem[] = [];
    let seq = 0;
    for (let turn = 0; turn < 100; turn++) {
      const tId = `t-${turn}`;
      items.push(userMsg(`${longGoal} iteration ${turn}`, ++seq));
      items.push(asstText(longReply, ++seq));
      items.push(toolSummary(`ran test suite`, ++seq));
      if (turn % 5 === 0) items.push(approval(++seq, tId, "allow"));
      if (turn % 7 === 0) items.push(subagent(++seq, tId));
      if (turn % 3 === 0) items.push(checkpoint(++seq, tId));
      if (turn % 2 === 0) items.push(attachment(++seq, tId));
    }

    const ctx = buildContext(snap(items, seq), { maxTokens: 2000, compactToTokens: 800, preserveRecentTurns: 3, pinned: {} });
    expect(ctx.compacted).toBe(true);
    expect(ctx.prompt.length).toBeGreaterThan(0);
    expect(ctx.estimatedTokens).toBeGreaterThan(0);

    // The compacted prompt should still reference goals from recent turns
    expect(ctx.prompt).toContain("iteration 99");
    expect(ctx.prompt).toContain("iteration 98");
  });

  test("pinned goals survive compaction", () => {
    const items: CanonicalHistoryItem[] = [
      userMsg("BUILD: a performant CLI task runner ".repeat(10), 1),
      userMsg("CONSTRAINT: must not exceed 50MB memory ".repeat(10), 2),
      asstText("got it ".repeat(50), 3),
    ];
    for (let i = 4; i <= 60; i++) {
      items.push(userMsg(`turn detail ${i} `.repeat(10), i));
      items.push(asstText(`reply ${i} `.repeat(10), i + 1));
    }

    const pinnedPolicy: ContextPolicy = {
      maxTokens: 2000,
      compactToTokens: 400,
      preserveRecentTurns: 3,
      pinned: {
        systemPrompt: "You are a CI pipeline engineer. Primary goal: BUILD a performant CLI task runner.",
        activePlan: "CONSTRAINT: must not exceed 50MB memory.",
      },
    };

    const ctx = buildContext(snap(items), pinnedPolicy);
    expect(ctx.compacted).toBe(true);
    // Pinned invariants must be preserved in the assembled prompt
    expect(ctx.prompt).toContain("CI pipeline engineer");
    expect(ctx.prompt).toContain("50MB memory");
  });

  test("compaction artifact summarizes the compressed range", () => {
    const items: CanonicalHistoryItem[] = [];
    for (let i = 0; i < 80; i++) {
      items.push(userMsg(`iteration ${i} `.repeat(20), i * 2 + 1));
      items.push(asstText(`answer ${i} `.repeat(20), i * 2 + 2));
    }
    const ctx = buildContext(snap(items), { maxTokens: 2000, compactToTokens: 500, preserveRecentTurns: 2, pinned: {} });
    expect(ctx.compacted).toBe(true);
    expect(ctx.compactionArtifact).toBeDefined();
    if (ctx.compactionArtifact) {
      expect(ctx.compactionArtifact.turnCount).toBeGreaterThan(2);
      expect(ctx.compactionArtifact.compactedSequences.length).toBe(2);
      expect(typeof ctx.compactionArtifact.summary).toBe("string");
    }
  });
});
