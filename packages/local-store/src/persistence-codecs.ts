import {
  RUN_STATUSES,
  type CanonicalEventType,
  type CommandId,
  type CommandReceipt,
  type JsonValue,
  type PermissionProfile,
  type RunId,
  type RunSnapshot,
} from "@relay/contracts";

const SCHEMA_VERSION = 1;
const PERMISSION_PROFILES = new Set<PermissionProfile>([
  "read-only",
  "workspace-write",
  "full-access",
]);
const EVENT_TYPES = new Set<CanonicalEventType>([
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
  "projection.published",
]);

type PersistedRecord<TKind extends string, TData> = {
  readonly schemaVersion: 1;
  readonly kind: TKind;
  readonly data: TData;
};

export class PersistedRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistedRecordError";
  }
}

export function encodeSnapshot(snapshot: RunSnapshot): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kind: "run_snapshot",
    data: snapshot,
  } satisfies PersistedRecord<"run_snapshot", RunSnapshot>);
}

export function decodeSnapshot(json: string): RunSnapshot {
  const parsed = parseJson(json, "run snapshot");
  const data =
    isRecord(parsed) && parsed.kind === "run_snapshot"
      ? unwrapVersioned(parsed, "run_snapshot")
      : parsed;
  return validateSnapshot(data);
}

export function encodeEventPayload(
  eventType: CanonicalEventType,
  payload: unknown,
): string {
  assertCanonicalEventPayload(eventType, payload);
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kind: "canonical_event_payload",
    eventType,
    data: payload,
  });
}

export function decodeEventPayload(
  expectedType: CanonicalEventType,
  json: string,
): unknown {
  const parsed = parseJson(json, `event ${expectedType}`);
  let data = parsed;
  if (isRecord(parsed) && parsed.kind === "canonical_event_payload") {
    data = unwrapVersioned(parsed, "canonical_event_payload");
    if (parsed.eventType !== expectedType) {
      throw new PersistedRecordError(
        `Persisted event type mismatch: expected ${expectedType}`,
      );
    }
  }
  assertCanonicalEventPayload(expectedType, data);
  return data;
}

export function encodeReceipt(receipt: CommandReceipt): string {
  return JSON.stringify(receipt);
}

export function decodeReceipt(
  json: string,
  expectedCommandId: CommandId,
  expectedRunId: RunId,
): CommandReceipt {
  const value = parseJson(json, "command receipt");
  if (!isRecord(value)) {
    throw new PersistedRecordError("Command receipt must be an object");
  }

  // Migration compatibility for pre-v4 receipts that stored only a snapshot.
  if (!("schemaVersion" in value) && "status" in value) {
    return {
      schemaVersion: 1,
      kind: "snapshot",
      commandId: expectedCommandId,
      runId: expectedRunId,
      snapshot: validateSnapshot(value),
    };
  }

  assertExactVersion(value);
  if (value.commandId !== expectedCommandId || value.runId !== expectedRunId) {
    throw new PersistedRecordError("Command receipt identity does not match its row");
  }
  if (value.kind !== "snapshot" && value.kind !== "turn") {
    throw new PersistedRecordError("Command receipt has an unknown kind");
  }
  const snapshot = validateSnapshot(value.snapshot);
  if (snapshot.runId !== expectedRunId) {
    throw new PersistedRecordError("Command receipt snapshot belongs to another run");
  }
  if (value.kind === "turn") {
    assertNonEmptyString(value.turnId, "command receipt turnId");
    return {
      schemaVersion: 1,
      kind: "turn",
      commandId: expectedCommandId,
      runId: expectedRunId,
      turnId: value.turnId as never,
      snapshot,
    };
  }
  return {
    schemaVersion: 1,
    kind: "snapshot",
    commandId: expectedCommandId,
    runId: expectedRunId,
    snapshot,
  };
}

function validateSnapshot(value: unknown): RunSnapshot {
  if (!isRecord(value)) {
    throw new PersistedRecordError("Run snapshot must be an object");
  }
  assertNonEmptyString(value.runId, "run snapshot runId");
  if (
    typeof value.status !== "string" ||
    !RUN_STATUSES.some((status) => status === value.status)
  ) {
    throw new PersistedRecordError("Run snapshot has an invalid status");
  }
  assertNonNegativeInteger(value.sequence, "run snapshot sequence");
  assertNonNegativeInteger(value.streamVersion, "run snapshot streamVersion");
  assertNonNegativeInteger(value.restartCount, "run snapshot restartCount");
  assertFiniteNumber(value.createdAt, "run snapshot createdAt");
  assertFiniteNumber(value.updatedAt, "run snapshot updatedAt");
  assertOptionalString(value.projectId, "run snapshot projectId");
  assertOptionalString(value.activeTurnId, "run snapshot activeTurnId");
  assertOptionalString(value.providerInstanceId, "run snapshot providerInstanceId");
  if (
    value.permissionProfile !== undefined &&
    (typeof value.permissionProfile !== "string" ||
      !PERMISSION_PROFILES.has(value.permissionProfile as PermissionProfile))
  ) {
    throw new PersistedRecordError("Run snapshot has an invalid permissionProfile");
  }
  validateOptionalWorkspace(value.workspace);
  validateOptionalProviderSession(value.providerSession);
  validateOptionalCheckpoint(value.checkpoint);
  if (value.reducerPayload !== undefined && !isJsonRecord(value.reducerPayload)) {
    throw new PersistedRecordError("Run snapshot reducerPayload must be JSON");
  }

  return value as RunSnapshot;
}

function assertCanonicalEventPayload(
  eventType: CanonicalEventType,
  value: unknown,
): void {
  if (!EVENT_TYPES.has(eventType)) {
    throw new PersistedRecordError(`Unknown canonical event type: ${eventType}`);
  }
  if (!isRecord(value)) {
    throw new PersistedRecordError(`Payload for ${eventType} must be an object`);
  }

  const requiredStrings: Partial<Record<CanonicalEventType, readonly string[]>> = {
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
  };
  for (const field of requiredStrings[eventType] ?? []) {
    assertNonEmptyString(value[field], `${eventType}.${field}`);
  }

  if (eventType === "run.created") {
    assertNonEmptyString(value.environmentId, "run.created.environmentId");
    assertNonEmptyString(value.projectId, "run.created.projectId");
  }
  if (eventType === "run.stopping") {
    assertNonEmptyString(value.reason, "run.stopping.reason");
  }
  if (eventType === "usage.recorded") {
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "thinkingTokens",
    ] as const) {
      assertFiniteNumber(value[field], `usage.recorded.${field}`);
    }
    assertNonEmptyString(value.modelId, "usage.recorded.modelId");
  }
  if (eventType === "projection.published") {
    assertFiniteNumber(value.cursor, "projection.published.cursor");
  }
}

function validateOptionalWorkspace(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new PersistedRecordError("workspace must be an object");
  for (const field of ["runId", "repoPath", "worktreePath", "baseCommit"] as const) {
    assertNonEmptyString(value[field], `workspace.${field}`);
  }
  assertFiniteNumber(value.createdAt, "workspace.createdAt");
  if (
    typeof value.permissionProfile !== "string" ||
    !PERMISSION_PROFILES.has(value.permissionProfile as PermissionProfile)
  ) {
    throw new PersistedRecordError("workspace has an invalid permissionProfile");
  }
}

function validateOptionalProviderSession(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new PersistedRecordError("providerSession must be an object");
  }
  assertNonEmptyString(
    value.providerInstanceId,
    "providerSession.providerInstanceId",
  );
  assertOptionalString(value.providerThreadId, "providerSession.providerThreadId");
}

function validateOptionalCheckpoint(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new PersistedRecordError("checkpoint must be an object");
  }
  for (const field of ["checkpointId", "turnId", "commit", "ref"] as const) {
    assertNonEmptyString(value[field], `checkpoint.${field}`);
  }
  assertFiniteNumber(value.capturedAt, "checkpoint.capturedAt");
}

function unwrapVersioned(value: Record<string, unknown>, kind: string): unknown {
  assertExactVersion(value);
  if (value.kind !== kind || !("data" in value)) {
    throw new PersistedRecordError(`Invalid persisted ${kind} record`);
  }
  return value.data;
}

function assertExactVersion(value: Record<string, unknown>): void {
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new PersistedRecordError(
      `Unsupported persisted schema version: ${String(value.schemaVersion)}`,
    );
  }
}

function parseJson(json: string, label: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new PersistedRecordError(`Invalid JSON in persisted ${label}`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PersistedRecordError(`${label} must be a non-empty string`);
  }
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined) assertNonEmptyString(value, label);
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PersistedRecordError(`${label} must be a finite number`);
  }
}

function assertNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PersistedRecordError(`${label} must be a non-negative integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
