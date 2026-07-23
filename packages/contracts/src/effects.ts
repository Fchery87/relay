import type {
  CheckpointId,
  CommandId,
  EffectId,
  ProviderInstanceId,
  RunId,
  TurnId,
} from "./ids";
import type {
  CheckpointResultPayload,
  ProviderEventPayload,
  WorkspaceResultPayload,
} from "./commands";

export type EffectIntent =
  | {
      readonly kind: "provider.start_session";
      readonly providerInstanceId: ProviderInstanceId;
    }
  | {
      readonly kind: "provider.resume_session";
      readonly providerInstanceId: ProviderInstanceId;
      readonly providerThreadId: string;
    }
  | {
      readonly kind: "provider.send_turn";
      readonly prompt: string;
      readonly turnId: TurnId;
    }
  | {
      readonly kind: "provider.steer_turn";
      readonly steering: string;
      readonly turnId: TurnId;
    }
  | {
      readonly kind: "provider.interrupt_turn";
      readonly reason: string;
      readonly turnId: TurnId;
    }
  | {
      readonly kind: "provider.resolve_approval";
      readonly approvalId: string;
      readonly resolution: "allow" | "deny";
      readonly turnId?: TurnId;
    }
  | { readonly kind: "provider.stop_session" }
  | { readonly kind: "workspace.create"; readonly repoPath: string }
  | { readonly kind: "workspace.reconcile"; readonly repoPath: string }
  | { readonly kind: "checkpoint.capture"; readonly turnId: TurnId }
  | {
      readonly kind: "checkpoint.restore";
      readonly checkpointId: CheckpointId;
    }
  | {
      readonly kind: "tool.execute";
      readonly toolName: string;
      readonly input: unknown;
    }
  | { readonly kind: "projection.publish" }
  | {
      readonly kind: "workflow.create_child";
      readonly workflowKind: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "workflow.complete_child";
      readonly childId: string;
      readonly result: unknown;
    };

export type EffectRetryClass = "never" | "transient" | "rate_limited";
export type EffectStatus = "pending" | "running" | "completed" | "failed";
export type EffectFailureKind =
  | "retryable"
  | "rate_limited"
  | "approval_required"
  | "terminal";

export type EffectCancellation = {
  readonly kind: EffectIntent["kind"];
  readonly reason: string;
};

export type DurableEffect = {
  readonly effectId: EffectId;
  /** Stable key reactors must pass to retry-capable external systems. */
  readonly idempotencyKey: EffectId;
  readonly runId: RunId;
  readonly commandId: CommandId;
  readonly effectIndex: number;
  readonly intent: EffectIntent;
  readonly status: EffectStatus;
  readonly attempts: number;
  readonly retryClass: EffectRetryClass;
  /** Durable eligibility timestamp; pending effects are not claimed before it. */
  readonly nextAttemptAt: number;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
  readonly lastError?: string;
  readonly lastErrorKind?: EffectFailureKind;
  readonly failedAt?: number;
  /** Recovery must emit failure without invoking this non-retryable effect. */
  readonly recoveryFailure?: string;
};

/** Reactor output is routed back through the engine as an internal command. */
export type ReactorCommandDraft =
  | { readonly type: "provider.event"; readonly payload: ProviderEventPayload }
  | { readonly type: "workspace.result"; readonly payload: WorkspaceResultPayload }
  | {
      readonly type: "checkpoint.result";
      readonly payload: CheckpointResultPayload;
    };

export type ReactorContext = {
  readonly idempotencyKey: EffectId;
  /** Reactors must stop external work when lease ownership is lost. */
  readonly signal: AbortSignal;
};

/**
 * `execute` is called at most once. Later attempts must reconcile external
 * state through `recover` using the same idempotency key; they never blindly
 * repeat the original side effect.
 */
export type EffectReactor = {
  readonly execute: (
    effect: DurableEffect,
    context: ReactorContext,
  ) => Promise<ReadonlyArray<ReactorCommandDraft>>;
  readonly recover: (
    effect: DurableEffect,
    context: ReactorContext,
  ) => Promise<ReadonlyArray<ReactorCommandDraft>>;
};

export type ReactorRegistry = Partial<
  Readonly<Record<EffectIntent["kind"], EffectReactor>>
>;
