import type { Command, CommandType } from "./commands";
import type { CanonicalEventType } from "./events";
import type { PermissionProfile } from "./permissions";

const COMMAND_TYPES = new Set<CommandType>([
  "run.create",
  "run.resume",
  "turn.send",
  "turn.steer",
  "turn.interrupt",
  "approval.resolve",
  "run.stop",
  "checkpoint.restore",
  "provider.event",
  "workspace.result",
  "checkpoint.result",
  "effect.result",
  "projection.ack",
]);

const CANONICAL_EVENT_TYPES = new Set<CanonicalEventType>([
  "run.created",
  "run.started",
  "run.stopping",
  "run.stopped",
  "run.failed",
  "provider.session.started",
  "provider.session.resumed",
  "provider.session.stopped",
  "turn.started",
  "turn.steered",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "assistant.delta",
  "assistant.completed",
  "activity.started",
  "activity.delta",
  "activity.completed",
  "activity.failed",
  "approval.requested",
  "approval.resolved",
  "usage.recorded",
  "checkpoint.captured",
  "checkpoint.restored",
  "checkpoint.compared",
  "projection.published",
]);

const TURN_SCOPED_EVENT_TYPES = new Set<CanonicalEventType>([
  "turn.started",
  "turn.steered",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "assistant.delta",
  "assistant.completed",
  "activity.started",
  "activity.delta",
  "activity.completed",
  "activity.failed",
  "checkpoint.captured",
]);

const PERMISSION_PROFILES = new Set<PermissionProfile>([
  "read-only",
  "workspace-write",
  "full-access",
]);

export class CommandSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandSchemaError";
  }
}

/** Validate an unknown command at the orchestration ingress boundary. */
export function assertCommandSchema(value: unknown): asserts value is Command {
  if (!isRecord(value)) throw new CommandSchemaError("Command must be an object");
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    throw new CommandSchemaError(
      `Unsupported command schema version: ${String(value.schemaVersion)}`,
    );
  }
  for (const field of ["commandId", "runId", "correlationId"] as const) {
    assertString(value[field], `Command ${field}`);
  }
  assertFiniteNumber(value.issuedAt, "Command issuedAt");
  if (
    typeof value.type !== "string" ||
    !COMMAND_TYPES.has(value.type as CommandType)
  ) {
    throw new CommandSchemaError(`Unknown command type: ${String(value.type)}`);
  }
  if (
    !isRecord(value.actor) ||
    !["user", "device", "provider", "system"].includes(
      String(value.actor.kind),
    )
  ) {
    throw new CommandSchemaError("Command actor is invalid");
  }
  assertString(value.actor.id, "Command actor id");
  if (!isRecord(value.payload)) {
    throw new CommandSchemaError(`Command ${value.type} payload must be an object`);
  }

  switch (value.type) {
    case "run.create":
      assertString(value.payload.projectId, "run.create projectId");
      break;
    case "turn.send":
      assertString(value.payload.prompt, "turn.send prompt");
      assertString(value.payload.turnId, "turn.send turnId");
      break;
    case "turn.steer":
      assertString(value.payload.steering, "turn.steer steering");
      break;
    case "turn.interrupt":
    case "run.stop":
      assertString(value.payload.reason, `${value.type} reason`);
      break;
    case "approval.resolve":
      assertString(value.payload.approvalId, "approval.resolve approvalId");
      if (
        value.payload.resolution !== "allow" &&
        value.payload.resolution !== "deny"
      ) {
        throw new CommandSchemaError("approval.resolve resolution is invalid");
      }
      break;
    case "checkpoint.restore":
      assertString(value.payload.checkpointId, "checkpoint.restore checkpointId");
      break;
    case "provider.event":
      assertString(
        value.payload.providerInstanceId,
        "provider.event providerInstanceId",
      );
      if (!isRecord(value.payload.normalizedEvent)) {
        throw new CommandSchemaError("provider.event normalizedEvent is invalid");
      }
      assertString(
        value.payload.normalizedEvent.eventId,
        "provider.event normalizedEvent eventId",
      );
      assertString(
        value.payload.normalizedEvent.type,
        "provider.event normalizedEvent type",
      );
      assertString(
        value.payload.normalizedEvent.correlationId,
        "provider.event normalizedEvent correlationId",
      );
      const payloadError = canonicalEventPayloadError(
        value.payload.normalizedEvent.type,
        value.payload.normalizedEvent.payload,
      );
      if (payloadError) {
        throw new CommandSchemaError(payloadError);
      }
      if (
        canonicalEventRequiresTurn(value.payload.normalizedEvent.type)
      ) {
        assertString(
          value.payload.normalizedEvent.turnId,
          `provider.event ${value.payload.normalizedEvent.type} turnId`,
        );
      }
      for (const field of [
        "turnId",
        "providerInstanceId",
        "causationId",
      ] as const) {
        if (value.payload.normalizedEvent[field] !== undefined) {
          assertString(
            value.payload.normalizedEvent[field],
            `provider.event normalizedEvent ${field}`,
          );
        }
      }
      break;
    case "checkpoint.result":
      for (const field of ["checkpointId", "commit", "ref"] as const) {
        assertString(value.payload[field], `checkpoint.result ${field}`);
      }
      break;
    case "effect.result":
      assertString(value.payload.effectId, "effect.result effectId");
      assertString(value.payload.effectKind, "effect.result effectKind");
      if (
        value.payload.status !== "failed" &&
        value.payload.status !== "completed"
      ) {
        throw new CommandSchemaError("effect.result status is invalid");
      }
      if (value.payload.status === "failed") {
        assertString(value.payload.error, "effect.result error");
      }
      if (value.payload.turnId !== undefined) {
        assertString(value.payload.turnId, "effect.result turnId");
      }
      if (
        value.payload.status === "failed" &&
        value.payload.effectKind === "provider.send_turn" &&
        value.payload.turnId === undefined
      ) {
        throw new CommandSchemaError(
          "effect.result turnId is required for provider.send_turn",
        );
      }
      if (
        value.payload.status === "completed" &&
        value.payload.effectKind === "provider.resolve_approval"
      ) {
        assertString(value.payload.approvalId, "effect.result approvalId");
        if (
          value.payload.resolution !== "allow" &&
          value.payload.resolution !== "deny"
        ) {
          throw new CommandSchemaError(
            "effect.result approval resolution is invalid",
          );
        }
      }
      break;
    case "projection.ack":
      assertFiniteNumber(value.payload.cursor, "projection.ack cursor");
      break;
    case "run.resume":
    case "workspace.result":
      break;
  }
}

/** Whether a canonical provider event must be bound to one Relay turn. */
export function canonicalEventRequiresTurn(type: unknown): boolean {
  return (
    typeof type === "string" &&
    TURN_SCOPED_EVENT_TYPES.has(type as CanonicalEventType)
  );
}

/**
 * Shared validation used at live ingress and persisted decoding boundaries.
 * Returns a message so each boundary can raise its own error category.
 */
export function canonicalEventPayloadError(
  type: unknown,
  payload: unknown,
): string | undefined {
  if (
    typeof type !== "string" ||
    !CANONICAL_EVENT_TYPES.has(type as CanonicalEventType)
  ) {
    return `Unknown canonical event type: ${String(type)}`;
  }
  if (!isRecord(payload)) {
    return `Payload for ${type} must be an object`;
  }

  const requiredStrings: Partial<
    Record<CanonicalEventType, readonly string[]>
  > = {
    "run.failed": ["error"],
    "provider.session.started": ["providerInstanceId"],
    "provider.session.resumed": ["providerInstanceId", "providerThreadId"],
    "provider.session.stopped": ["providerInstanceId", "reason"],
    "turn.started": ["prompt"],
    "turn.steered": ["steering"],
    "turn.failed": ["error"],
    "turn.interrupted": ["reason"],
    "assistant.delta": ["text"],
    "activity.started": ["activityId", "kind"],
    "activity.delta": ["activityId", "content"],
    "activity.completed": ["activityId"],
    "activity.failed": ["activityId", "error"],
    "approval.requested": ["approvalId", "capability", "risk", "details"],
    "approval.resolved": ["approvalId", "resolution"],
    "checkpoint.captured": ["checkpointId", "commit", "ref"],
    "checkpoint.restored": ["checkpointId", "commit"],
    "checkpoint.compared": ["fromCheckpointId", "toCheckpointId"],
  };
  for (const field of requiredStrings[type as CanonicalEventType] ?? []) {
    if (!isNonEmptyString(payload[field])) {
      return `${type}.${field} must be a non-empty string`;
    }
  }

  if (type === "run.created") {
    for (const field of ["environmentId", "projectId"] as const) {
      if (!isNonEmptyString(payload[field])) {
        return `run.created.${field} must be a non-empty string`;
      }
    }
    if (
      payload.permissionProfile !== undefined &&
      !PERMISSION_PROFILES.has(payload.permissionProfile as PermissionProfile)
    ) {
      return "run.created.permissionProfile is invalid";
    }
    const providerError = optionalStringError(
      payload.providerInstanceId,
      "run.created.providerInstanceId",
    );
    if (providerError) return providerError;
  }
  if (
    type === "run.stopping" &&
    payload.reason !== "user" &&
    payload.reason !== "error" &&
    payload.reason !== "shutdown"
  ) {
    return "run.stopping.reason is invalid";
  }
  if (
    type === "approval.resolved" &&
    payload.resolution !== "allow" &&
    payload.resolution !== "deny"
  ) {
    return "approval.resolved.resolution is invalid";
  }
  if (
    type === "provider.session.stopped" &&
    payload.reason !== "user" &&
    payload.reason !== "completed" &&
    payload.reason !== "error"
  ) {
    return "provider.session.stopped.reason is invalid";
  }
  const optionalStrings: Partial<
    Record<CanonicalEventType, readonly string[]>
  > = {
    "provider.session.started": ["providerThreadId"],
    "turn.completed": ["summary"],
    "activity.started": ["toolName"],
    "activity.completed": ["summary"],
  };
  for (const field of optionalStrings[type as CanonicalEventType] ?? []) {
    const error = optionalStringError(payload[field], `${type}.${field}`);
    if (error) return error;
  }
  if (type === "usage.recorded") {
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "thinkingTokens",
    ] as const) {
      if (
        typeof payload[field] !== "number" ||
        !Number.isFinite(payload[field]) ||
        payload[field] < 0
      ) {
        return `usage.recorded.${field} must be a non-negative finite number`;
      }
    }
    if (!isNonEmptyString(payload.modelId)) {
      return "usage.recorded.modelId must be a non-empty string";
    }
  }
  if (type === "checkpoint.compared" && typeof payload.content !== "string") {
    return "checkpoint.compared.content must be a string";
  }
  if (
    type === "projection.published" &&
    (typeof payload.cursor !== "number" || !Number.isFinite(payload.cursor))
  ) {
    return "projection.published.cursor must be a finite number";
  }
  return undefined;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandSchemaError(`${label} must be a non-empty string`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalStringError(
  value: unknown,
  label: string,
): string | undefined {
  return value === undefined || isNonEmptyString(value)
    ? undefined
    : `${label} must be a non-empty string when provided`;
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CommandSchemaError(`${label} must be a finite number`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
