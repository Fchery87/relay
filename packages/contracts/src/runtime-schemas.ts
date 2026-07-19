import type { Command, CommandType } from "./commands";

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
      break;
    case "checkpoint.result":
      for (const field of ["checkpointId", "commit", "ref"] as const) {
        assertString(value.payload[field], `checkpoint.result ${field}`);
      }
      break;
    case "effect.result":
      assertString(value.payload.effectId, "effect.result effectId");
      assertString(value.payload.effectKind, "effect.result effectKind");
      assertString(value.payload.error, "effect.result error");
      if (value.payload.status !== "failed") {
        throw new CommandSchemaError("effect.result status is invalid");
      }
      if (value.payload.turnId !== undefined) {
        assertString(value.payload.turnId, "effect.result turnId");
      }
      if (
        value.payload.effectKind === "provider.send_turn" &&
        value.payload.turnId === undefined
      ) {
        throw new CommandSchemaError(
          "effect.result turnId is required for provider.send_turn",
        );
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

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandSchemaError(`${label} must be a non-empty string`);
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CommandSchemaError(`${label} must be a finite number`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
