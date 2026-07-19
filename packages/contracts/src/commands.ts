import type {
  CausationId,
  CommandId,
  CorrelationId,
  EffectId,
  ProviderInstanceId,
  RunId,
  TurnId,
} from "./ids";
import type { CanonicalEventDraft } from "./events";

// ---------------------------------------------------------------------------
// Command envelope
// ---------------------------------------------------------------------------

/** Who or what issued a command. */
export type CommandActor =
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "device"; readonly id: string }
  | { readonly kind: "provider"; readonly id: string }
  | { readonly kind: "system"; readonly id: string };

/** The stable envelope for every harness command. */
export type CommandEnvelope<TType extends string, TPayload> = {
  /** Version 1 is emitted by current producers; absence is accepted for legacy callers. */
  readonly schemaVersion?: 1;
  readonly commandId: CommandId;
  readonly type: TType;
  readonly runId: RunId;
  readonly expectedStreamVersion?: number;
  readonly correlationId: CorrelationId;
  readonly causationId?: CausationId;
  readonly actor: CommandActor;
  readonly issuedAt: number; // unix ms
  readonly payload: TPayload;
};

// ---------------------------------------------------------------------------
// External commands — originate from the browser / user, arrive via Convex.
// ---------------------------------------------------------------------------

export type ExternalCommand =
  | CreateRunCommand
  | ResumeRunCommand
  | SendTurnCommand
  | SteerTurnCommand
  | InterruptTurnCommand
  | ResolveApprovalCommand
  | StopRunCommand
  | RestoreCheckpointCommand;

export type ExternalCommandType = ExternalCommand["type"];

// --- create ---

export type CreateRunPayload = {
  readonly projectId: string;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly permissionProfile?: "read-only" | "workspace-write" | "full-access";
  readonly initialPrompt?: string;
};

export type CreateRunCommand = CommandEnvelope<"run.create", CreateRunPayload>;

// --- resume ---

export type ResumeRunPayload = Record<string, never>;
export type ResumeRunCommand = CommandEnvelope<"run.resume", ResumeRunPayload>;

// --- send ---

export type SendTurnPayload = {
  readonly prompt: string;
  readonly turnId: TurnId;
};
export type SendTurnCommand = CommandEnvelope<"turn.send", SendTurnPayload>;

// --- steer ---

export type SteerTurnPayload = { readonly steering: string };
export type SteerTurnCommand = CommandEnvelope<"turn.steer", SteerTurnPayload>;

// --- interrupt ---

export type InterruptTurnPayload = { readonly reason: string };
export type InterruptTurnCommand = CommandEnvelope<
  "turn.interrupt",
  InterruptTurnPayload
>;

// --- resolve approval ---

export type ResolveApprovalPayload = {
  readonly approvalId: string;
  readonly resolution: "allow" | "deny";
};

export type ResolveApprovalCommand = CommandEnvelope<
  "approval.resolve",
  ResolveApprovalPayload
>;

// --- stop ---

export type StopRunPayload = { readonly reason: string };
export type StopRunCommand = CommandEnvelope<"run.stop", StopRunPayload>;

// --- restore ---

export type RestoreCheckpointPayload = { readonly checkpointId: string };
export type RestoreCheckpointCommand = CommandEnvelope<
  "checkpoint.restore",
  RestoreCheckpointPayload
>;

// ---------------------------------------------------------------------------
// Internal commands — originate from reactors / the orchestration engine.
// ---------------------------------------------------------------------------

export type InternalCommand =
  | ProviderEventCommand
  | WorkspaceResultCommand
  | CheckpointResultCommand
  | EffectResultCommand
  | ProjectionAckCommand;
export type InternalCommandType = InternalCommand["type"];

export type ProviderEventPayload = {
  readonly providerInstanceId: ProviderInstanceId;
  /** Normalised canonical event data produced by the provider adapter. */
  readonly normalizedEvent: CanonicalEventDraft;
};

export type ProviderEventCommand = CommandEnvelope<
  "provider.event",
  ProviderEventPayload
>;

export type WorkspaceResultPayload = {
  readonly kind: string;
  readonly result: unknown;
};

export type WorkspaceResultCommand = CommandEnvelope<
  "workspace.result",
  WorkspaceResultPayload
>;

export type CheckpointResultPayload = {
  readonly checkpointId: string;
  readonly commit: string;
  readonly ref: string;
};

export type CheckpointResultCommand = CommandEnvelope<
  "checkpoint.result",
  CheckpointResultPayload
>;

export type EffectResultPayload =
  | {
      readonly effectId: EffectId;
      readonly effectKind: string;
      readonly status: "completed";
      readonly turnId?: TurnId;
      readonly approvalId?: string;
      readonly resolution?: "allow" | "deny";
    }
  | {
      readonly effectId: EffectId;
      readonly effectKind: string;
      readonly status: "failed";
      readonly error: string;
      readonly turnId?: TurnId;
      readonly approvalId?: string;
    };

export type EffectResultCommand = CommandEnvelope<
  "effect.result",
  EffectResultPayload
>;

export type ProjectionAckPayload = { readonly cursor: number };
export type ProjectionAckCommand = CommandEnvelope<
  "projection.ack",
  ProjectionAckPayload
>;

/** Every command the harness can process. */
export type Command = ExternalCommand | InternalCommand;
export type CommandType = Command["type"];
