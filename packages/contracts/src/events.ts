import type {
  ActivityId,
  ApprovalId,
  CausationId,
  CheckpointId,
  CorrelationId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  TurnId,
} from "./ids";
import type { PermissionProfile } from "./permissions";

// ---------------------------------------------------------------------------
// Event envelope — every canonical event in the system uses this shape.
// `sequence` and `streamVersion` are assigned by storage; they do not appear
// in the envelope definition because they are assigned at persistence time.
// ---------------------------------------------------------------------------

/** The stable envelope for every canonical harness event. */
export type EventEnvelope<TType extends string, TPayload> = {
  readonly eventId: EventId;
  readonly sequence: number;
  readonly streamVersion: number;
  readonly type: TType;
  readonly runId: RunId;
  readonly turnId?: TurnId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly correlationId: CorrelationId;
  readonly causationId?: CausationId;
  readonly occurredAt: number; // unix ms
  readonly payload: TPayload;
};

// ---------------------------------------------------------------------------
// Canonical event union — every event type the harness can emit.
// Provider-native notification names are NEVER encoded as canonical types.
// ---------------------------------------------------------------------------

export type CanonicalEvent =
  // --- run lifecycle ---
  | RunCreatedEvent
  | RunStartedEvent
  | RunStoppingEvent
  | RunStoppedEvent
  | RunFailedEvent
  // --- provider session lifecycle ---
  | ProviderSessionStartedEvent
  | ProviderSessionResumedEvent
  | ProviderSessionStoppedEvent
  // --- turn lifecycle ---
  | TurnStartedEvent
  | TurnSteeredEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnInterruptedEvent
  // --- assistant output ---
  | AssistantDeltaEvent
  | AssistantCompletedEvent
  // --- activity (tool calls, MCP, subagent) ---
  | ActivityStartedEvent
  | ActivityDeltaEvent
  | ActivityCompletedEvent
  | ActivityFailedEvent
  // --- governance ---
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  // --- usage ---
  | UsageRecordedEvent
  // --- workspace / checkpoint ---
  | CheckpointCapturedEvent
  | CheckpointRestoredEvent
  | CheckpointComparedEvent
  | WorkspaceDiffUpdatedEvent
  | GitActionUpdatedEvent
  | RunConfigurationUpdatedEvent
  | PlanUpdatedEvent
  | ReviewCommentCreatedEvent
  | ReviewCommentResolvedEvent
  // --- projection synchronisation ---
  | ProjectionPublishedEvent;

export type CanonicalEventType = CanonicalEvent["type"];

/**
 * A canonical event before storage assigns its per-run ordering metadata.
 * Provider adapters emit this shape after normalising provider-native data.
 */
export type CanonicalEventDraft =
  CanonicalEvent extends infer TEvent
    ? TEvent extends CanonicalEvent
      ? Pick<
          TEvent,
          | "eventId"
          | "type"
          | "payload"
          | "turnId"
          | "providerInstanceId"
          | "correlationId"
          | "causationId"
        >
      : never
    : never;

// --- payloads ---

export type RunCreatedPayload = {
  readonly environmentId: EnvironmentId;
  readonly mode?: "chat" | "plan";
  readonly projectId: ProjectId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly permissionProfile?: PermissionProfile;
  readonly title?: string;
};

export type RunCreatedEvent = EventEnvelope<"run.created", RunCreatedPayload>;

export type RunStartedPayload = Record<string, never>;
export type RunStartedEvent = EventEnvelope<"run.started", RunStartedPayload>;

export type RunStoppingPayload = { readonly reason: "user" | "error" | "shutdown" };
export type RunStoppingEvent = EventEnvelope<"run.stopping", RunStoppingPayload>;

export type RunStoppedPayload = Record<string, never>;
export type RunStoppedEvent = EventEnvelope<"run.stopped", RunStoppedPayload>;

export type RunFailedPayload = { readonly error: string };
export type RunFailedEvent = EventEnvelope<"run.failed", RunFailedPayload>;

// --- provider session ---

export type ProviderSessionStartedPayload = {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId?: string;
};

export type ProviderSessionStartedEvent = EventEnvelope<
  "provider.session.started",
  ProviderSessionStartedPayload
>;

export type ProviderSessionResumedPayload = {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId: string;
};

export type ProviderSessionResumedEvent = EventEnvelope<
  "provider.session.resumed",
  ProviderSessionResumedPayload
>;

export type ProviderSessionStoppedPayload = {
  readonly providerInstanceId: ProviderInstanceId;
  readonly reason: "user" | "completed" | "error";
};

export type ProviderSessionStoppedEvent = EventEnvelope<
  "provider.session.stopped",
  ProviderSessionStoppedPayload
>;

// --- turn ---

export type TurnStartedPayload = { readonly prompt: string };
export type TurnStartedEvent = EventEnvelope<"turn.started", TurnStartedPayload>;

export type TurnSteeredPayload = { readonly steering: string };
export type TurnSteeredEvent = EventEnvelope<"turn.steered", TurnSteeredPayload>;

export type TurnCompletedPayload = { readonly summary?: string };
export type TurnCompletedEvent = EventEnvelope<"turn.completed", TurnCompletedPayload>;

export type TurnFailedPayload = { readonly error: string };
export type TurnFailedEvent = EventEnvelope<"turn.failed", TurnFailedPayload>;

export type TurnInterruptedPayload = { readonly reason: string };
export type TurnInterruptedEvent = EventEnvelope<"turn.interrupted", TurnInterruptedPayload>;

// --- assistant ---

export type AssistantDeltaPayload = { readonly text: string };
export type AssistantDeltaEvent = EventEnvelope<"assistant.delta", AssistantDeltaPayload>;

export type AssistantCompletedPayload = Record<string, never>;
export type AssistantCompletedEvent = EventEnvelope<
  "assistant.completed",
  AssistantCompletedPayload
>;

// --- activity ---

export type ActivityStartedPayload = {
  readonly activityId: ActivityId;
  readonly kind: string;
  readonly toolName?: string;
};

export type ActivityStartedEvent = EventEnvelope<
  "activity.started",
  ActivityStartedPayload
>;

export type ActivityDeltaPayload = {
  readonly activityId: ActivityId;
  readonly content: string;
};

export type ActivityDeltaEvent = EventEnvelope<"activity.delta", ActivityDeltaPayload>;

export type ActivityCompletedPayload = {
  readonly activityId: ActivityId;
  readonly summary?: string;
  readonly result?: unknown;
};

export type ActivityCompletedEvent = EventEnvelope<
  "activity.completed",
  ActivityCompletedPayload
>;

export type ActivityFailedPayload = {
  readonly activityId: ActivityId;
  readonly error: string;
};

export type ActivityFailedEvent = EventEnvelope<"activity.failed", ActivityFailedPayload>;

// --- approval ---

export type ApprovalRequestedPayload = {
  readonly approvalId: ApprovalId;
  readonly capability: string;
  readonly risk: string;
  readonly details: string;
};

export type ApprovalRequestedEvent = EventEnvelope<
  "approval.requested",
  ApprovalRequestedPayload
>;

export type ApprovalResolvedPayload = {
  readonly approvalId: ApprovalId;
  readonly resolution: "allow" | "deny";
};

export type ApprovalResolvedEvent = EventEnvelope<
  "approval.resolved",
  ApprovalResolvedPayload
>;

// --- usage ---

export type UsageRecordedPayload = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly thinkingTokens: number;
  readonly modelId: string;
};

export type UsageRecordedEvent = EventEnvelope<"usage.recorded", UsageRecordedPayload>;

// --- checkpoint ---

export type CheckpointCapturedPayload = {
  readonly checkpointId: CheckpointId;
  readonly commit: string;
  readonly ref: string;
};

export type CheckpointCapturedEvent = EventEnvelope<
  "checkpoint.captured",
  CheckpointCapturedPayload
>;

export type CheckpointRestoredPayload = {
  readonly checkpointId: CheckpointId;
  readonly commit: string;
};

export type CheckpointRestoredEvent = EventEnvelope<
  "checkpoint.restored",
  CheckpointRestoredPayload
>;

export type CheckpointComparedPayload = {
  readonly fromCheckpointId: CheckpointId;
  readonly toCheckpointId: CheckpointId;
  readonly content: string;
};

export type CheckpointComparedEvent = EventEnvelope<
  "checkpoint.compared",
  CheckpointComparedPayload
>;

export type WorkspaceDiffUpdatedPayload = {
  readonly baseCommit: string;
  readonly content: string;
};

export type WorkspaceDiffUpdatedEvent = EventEnvelope<
  "workspace.diff.updated",
  WorkspaceDiffUpdatedPayload
>;

export type GitActionUpdatedPayload = {
  readonly action: "stage" | "commit" | "push";
  readonly actionId: string;
  readonly commit?: string;
  readonly error?: string;
  readonly message?: string;
  readonly status: "running" | "complete" | "failed";
};

export type GitActionUpdatedEvent = EventEnvelope<"git.action.updated", GitActionUpdatedPayload>;

export type RunConfigurationUpdatedPayload = {
  readonly budgetUsd?: number | null;
  readonly modelId?: string;
  readonly permissionProfile?: PermissionProfile;
  readonly thinkingLevel?: "none" | "low" | "medium" | "high";
};

export type RunConfigurationUpdatedEvent = EventEnvelope<"run.configuration.updated", RunConfigurationUpdatedPayload>;

export type PlanPhase = "planning" | "review" | "building" | "complete";
export type PlanArtifactStatus = "draft" | "approved";

export type PlanUpdatedPayload = {
  readonly buildModelId?: string;
  readonly content?: string;
  readonly phase: PlanPhase;
  readonly planModelId?: string;
  readonly revision?: number;
  readonly status?: PlanArtifactStatus;
};

export type PlanUpdatedEvent = EventEnvelope<"plan.updated", PlanUpdatedPayload>;

export type ReviewCommentCreatedPayload = {
  readonly commentId: string;
  readonly content: string;
  readonly endLine: number;
  readonly filePath: string;
  readonly startLine: number;
};

export type ReviewCommentCreatedEvent = EventEnvelope<
  "review.comment.created",
  ReviewCommentCreatedPayload
>;

export type ReviewCommentResolvedPayload = {
  readonly commentId: string;
};

export type ReviewCommentResolvedEvent = EventEnvelope<
  "review.comment.resolved",
  ReviewCommentResolvedPayload
>;

// --- projection ---

export type ProjectionPublishedPayload = { readonly cursor: number };
export type ProjectionPublishedEvent = EventEnvelope<
  "projection.published",
  ProjectionPublishedPayload
>;
