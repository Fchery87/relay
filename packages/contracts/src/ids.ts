// Branded identifier types for the harness kernel. Each id is a string
// tagged with a phantom brand to prevent accidental interchange.

declare const ID_BRAND: unique symbol;

/** A branded string identifier. */
export type BrandedId<T extends string> = string & { [ID_BRAND]: T };

/** Identifies a Relay environment (deployment). */
export type EnvironmentId = BrandedId<"EnvironmentId">;

/** Identifies a project within an environment. */
export type ProjectId = BrandedId<"ProjectId">;

/** Identifies a single agent run — created once, survives restarts. */
export type RunId = BrandedId<"RunId">;

/** Identifies a single turn within a run. */
export type TurnId = BrandedId<"TurnId">;

/** Identifies an assistant activity item (text block, tool call, …). */
export type ActivityId = BrandedId<"ActivityId">;

/** Identifies a governance approval request. */
export type ApprovalId = BrandedId<"ApprovalId">;

/** Identifies a worktree checkpoint. */
export type CheckpointId = BrandedId<"CheckpointId">;

/** Identifies a provider instance (e.g. a configured Codex installation). */
export type ProviderInstanceId = BrandedId<"ProviderInstanceId">;

/** Globally unique command identifier for exactly-once semantics. */
export type CommandId = BrandedId<"CommandId">;

/** Globally unique event identifier. */
export type EventId = BrandedId<"EventId">;

/** Links a group of related events/commands across tiers. */
export type CorrelationId = BrandedId<"CorrelationId">;

/** Identifies the event that caused this command/event (causal chain). */
export type CausationId = BrandedId<"CausationId">;
