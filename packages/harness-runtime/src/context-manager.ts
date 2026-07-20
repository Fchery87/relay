import type { CanonicalHistoryItem, HistorySnapshot, CompactionArtifactItem } from "@relay/contracts";

// ---------------------------------------------------------------------------
// Context policy
// ---------------------------------------------------------------------------

export type ContextPolicy = {
  /** Token budget before compaction triggers. */
  readonly maxTokens: number;
  /** Target token count after compaction. */
  readonly compactToTokens: number;
  /** Maximum number of most-recent turns to preserve after compaction. */
  readonly preserveRecentTurns: number;
  /** Invariants that are never compacted. */
  readonly pinned: {
    readonly systemPrompt?: string;
    readonly activePlan?: string;
    readonly unresolvedComments?: ReadonlyArray<string>;
  };
};

// ---------------------------------------------------------------------------
// Context manager — manages what goes into the system prompt.
// Compacts at 80% budget toward 40%, preserves pinned invariants.
// ---------------------------------------------------------------------------

export type ContextSnapshot = {
  /** The assembled prompt ready to send to the provider. */
  readonly prompt: string;
  /** Estimated token count. */
  readonly estimatedTokens: number;
  /** Whether compaction happened. */
  readonly compacted: boolean;
  /** If compacted, the compaction artifact. */
  readonly compactionArtifact?: CompactionArtifactItem;
};

/**
 * Build a context snapshot from the canonical history, applying
 * the compaction policy if the token budget is exceeded.
 */
export function buildContext(
  history: HistorySnapshot,
  policy: ContextPolicy,
): ContextSnapshot {
  let parts: string[] = [];
  let tokenEstimate = 0;

  // 1. Pinned invariants (never compacted)
  if (policy.pinned.systemPrompt) {
    parts.push(`[System]\n${policy.pinned.systemPrompt}`);
    tokenEstimate += estimateTokens(policy.pinned.systemPrompt);
  }
  if (policy.pinned.activePlan) {
    parts.push(`[Active Plan]\n${policy.pinned.activePlan}`);
    tokenEstimate += estimateTokens(policy.pinned.activePlan);
  }
  if (policy.pinned.unresolvedComments?.length) {
    const comments = policy.pinned.unresolvedComments
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n");
    parts.push(`[Unresolved Review Comments]\n${comments}`);
    tokenEstimate += estimateTokens(comments);
  }

  // 2. History items, newest first for compaction decisions
  const items = [...history.items].reverse();
  const budgetForHistory = policy.maxTokens - tokenEstimate;

  if (budgetForHistory <= 0) {
    return {
      prompt: parts.join("\n\n"),
      estimatedTokens: tokenEstimate,
      compacted: false,
    };
  }

  // 3. Select a deterministic recent-turn suffix, then compact older items.
  let historyTokens = 0;
  const toInclude: CanonicalHistoryItem[] = [];
  const compacted: CanonicalHistoryItem[] = [];
  let triggered = false;
  const totalHistoryTokens = items.reduce((sum, item) => sum + estimateItemTokens(item), 0);
  const shouldCompact = totalHistoryTokens > budgetForHistory * 0.8;
  const recentTurnIds = new Set<string>();
  for (const item of items) {
    const turnId = "turnId" in item ? (item as { turnId?: string }).turnId : undefined;
    if (turnId) recentTurnIds.add(turnId);
    if (recentTurnIds.size >= policy.preserveRecentTurns) break;
  }
  for (const item of items) {
    const turnId = "turnId" in item ? (item as { turnId?: string }).turnId : undefined;
    const recent = Boolean(turnId && recentTurnIds.has(turnId));
    const t = estimateItemTokens(item);
    if (!shouldCompact || (recent && t <= budgetForHistory * 0.8 && historyTokens + t <= budgetForHistory) || (!recent && historyTokens + t <= policy.compactToTokens)) {
      historyTokens += t;
      toInclude.push(item);
    } else {
      triggered = true;
      compacted.push(item);
    }
  }

  // Reverse back to chronological order
  toInclude.reverse();

  // 4. If compaction triggered, summarize and add to the end
  if (triggered && compacted.length > 0) {
    const compactSequence: [number, number] = [
      compacted[compacted.length - 1]?.createdAt ?? 0,
      compacted[0]?.createdAt ?? Date.now(),
    ];
    const turnCount = new Set(
      compacted
        .map((i) => ("turnId" in i ? (i as { turnId?: string }).turnId : undefined))
        .filter(Boolean),
    ).size;

    const summary = buildCompactionSummary(compacted);
    const artifact: CompactionArtifactItem = {
      kind: "compaction_artifact",
      id: `compact-${Date.now()}`,
      summary,
      compactedSequences: compactSequence,
      turnCount,
      createdAt: Date.now(),
    };

    toInclude.push(artifact);
    historyTokens += estimateTokens(summary);
  }

  // 5. Assemble
  const historyPrompt = toInclude.map(formatHistoryItem).join("\n\n");
  parts.push(historyPrompt === "" ? "[No history]" : historyPrompt);

  return {
    prompt: parts.join("\n\n"),
    estimatedTokens: tokenEstimate + historyTokens,
    compacted: triggered,
    compactionArtifact: triggered
      ? (toInclude.find((i) => i.kind === "compaction_artifact") as CompactionArtifactItem | undefined)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHistoryItem(item: CanonicalHistoryItem): string {
  switch (item.kind) {
    case "user_message":
      return `[User]\n${item.content}`;
    case "assistant_text":
      return `[Assistant]\n${item.text}`;
    case "activity_summary":
      return `[Tool: ${item.toolName}]\n${item.summary}`;
    case "approval":
      return `[Approval: ${item.capability} — ${item.resolution}]\nRisk: ${item.risk}`;
    case "subagent_result":
      return `[Subagent: ${item.roleName}]\n${item.summary}`;
    case "checkpoint":
      return `[Checkpoint: ${item.commit.substring(0, 7)}]\nRef: ${item.ref}`;
    case "compaction_artifact":
      return `[Compacted Context]\n${item.summary}`;
    case "attachment":
      return `[Attachment: ${item.name} (${item.size} bytes)]`;
    default: {
      const _exhaustive: never = item;
      void _exhaustive;
      return "";
    }
  }
}

function buildCompactionSummary(items: CanonicalHistoryItem[]): string {
  const turns = new Set(
    items
      .map((i) => ("turnId" in i ? (i as { turnId?: string }).turnId : undefined))
      .filter(Boolean),
  ).size;
  const userMsgs = items.filter((i) => i.kind === "user_message").length;
  const tools = items.filter((i) => i.kind === "activity_summary").length;
  const approvals = items.filter((i) => i.kind === "approval").length;

  return (
    `Compacted ${items.length} items across ~${turns} turns. ` +
    `Includes ${userMsgs} user messages, ${tools} tool calls, ${approvals} approvals.`
  );
}

function estimateTokens(text: string): number {
  // Rough heuristic: ~4 chars per token
  return Math.ceil(text.length / 4);
}

function estimateItemTokens(item: CanonicalHistoryItem): number {
  switch (item.kind) {
    case "user_message":
      return estimateTokens(item.content);
    case "assistant_text":
      return estimateTokens(item.text);
    case "activity_summary":
      return estimateTokens(item.summary);
    case "compaction_artifact":
      return estimateTokens(item.summary);
    default:
      return 20; // fixed overhead for short items
  }
}
