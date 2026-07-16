import type { ActivityId, ApprovalId, CheckpointId, RunId, TurnId } from "./ids";

// ---------------------------------------------------------------------------
// Canonical history items — provider-independent, reconstructable from events.
// Raw provider payloads are never included.
// ---------------------------------------------------------------------------

export type CanonicalHistoryItem =
  | UserMessageItem
  | AssistantTextItem
  | ActivitySummaryItem
  | ApprovalItem
  | SubagentResultItem
  | CheckpointItem
  | CompactionArtifactItem
  | AttachmentItem;

// --- provenance ---

export type HistoryProvenance = {
  /** The event sequence that produced this item (for deterministic replay). */
  readonly eventSequences: ReadonlyArray<number>;
  readonly correlationId: string;
};

// --- item types ---

export type UserMessageItem = {
  readonly kind: "user_message";
  readonly id: string;
  readonly content: string;
  readonly turnId: TurnId;
  readonly createdAt: number;
  readonly provenance: HistoryProvenance;
};

export type AssistantTextItem = {
  readonly kind: "assistant_text";
  readonly id: string;
  readonly text: string;
  readonly turnId: TurnId;
  readonly createdAt: number;
  readonly provenance: HistoryProvenance;
};

export type ActivitySummaryItem = {
  readonly kind: "activity_summary";
  readonly id: string;
  readonly activityId: ActivityId;
  readonly toolName: string;
  readonly summary: string;
  readonly turnId: TurnId;
  readonly createdAt: number;
  readonly provenance: HistoryProvenance;
};

export type ApprovalItem = {
  readonly kind: "approval";
  readonly id: string;
  readonly approvalId: ApprovalId;
  readonly capability: string;
  readonly risk: string;
  readonly resolution: "allow" | "deny";
  readonly turnId: TurnId;
  readonly createdAt: number;
  readonly provenance: HistoryProvenance;
};

export type SubagentResultItem = {
  readonly kind: "subagent_result";
  readonly id: string;
  readonly roleName: string;
  readonly summary: string;
  readonly resultRef?: string;
  readonly turnId: TurnId;
  readonly createdAt: number;
  readonly provenance: HistoryProvenance;
};

export type CheckpointItem = {
  readonly kind: "checkpoint";
  readonly id: string;
  readonly checkpointId: CheckpointId;
  readonly commit: string;
  readonly ref: string;
  readonly turnId: TurnId;
  readonly createdAt: number;
  readonly provenance: HistoryProvenance;
};

export type CompactionArtifactItem = {
  readonly kind: "compaction_artifact";
  readonly id: string;
  /** Summary of the compacted range. */
  readonly summary: string;
  /** The sequence range that was compacted (inclusive start, exclusive end). */
  readonly compactedSequences: readonly [number, number];
  readonly turnCount: number;
  readonly createdAt: number;
  /** Reference to the full artifact on disk (for recovery/exports). */
  readonly artifactPath?: string;
};

export type AttachmentItem = {
  readonly kind: "attachment";
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly mimeType?: string;
  readonly size: number;
  readonly turnId: TurnId;
  readonly createdAt: number;
  readonly provenance: HistoryProvenance;
};

// ---------------------------------------------------------------------------
// History snapshot — the full, deterministic state at a point in time.
// ---------------------------------------------------------------------------

export type HistorySnapshot = {
  readonly runId: RunId;
  readonly items: ReadonlyArray<CanonicalHistoryItem>;
  /** The event sequence this snapshot covers (exclusive). */
  readonly throughSequence: number;
  readonly createdAt: number;
};
