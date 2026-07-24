import type { EffectId, RunId } from "@relay/contracts";
import type { StoreDatabase } from "./database";
import { PersistedRecordError } from "./persistence-codecs";

export type ExternalOperationState =
  | "prepared"
  | "dispatched"
  | "observed"
  | "committed"
  | "outcome_unknown";

export type ExternalOperation = {
  readonly operationId: string;
  readonly effectId: EffectId;
  readonly idempotencyKey: string;
  readonly runId: RunId;
  readonly operationKind: string;
  readonly state: ExternalOperationState;
  readonly providerInstanceId?: string;
  readonly nativeReference?: string;
  readonly preparedAt: number;
  readonly dispatchedAt?: number;
  readonly observedAt?: number;
  readonly committedAt?: number;
  readonly lastError?: string;
  readonly schemaVersion: 1;
};

export type PrepareExternalOperationInput = {
  readonly operationId: string;
  readonly effectId: EffectId;
  readonly idempotencyKey: string;
  readonly runId: RunId;
  readonly operationKind: string;
  readonly providerInstanceId?: string;
  readonly now?: number;
};

export function prepareExternalOperation(
  db: StoreDatabase,
  input: PrepareExternalOperationInput,
): ExternalOperation {
  const now = input.now ?? Date.now();
  db.run(
    `INSERT OR IGNORE INTO external_operations (
      operation_id, effect_id, idempotency_key, run_id, operation_kind, state,
      provider_instance_id, prepared_at, schema_version
    ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, 1)`,
    [
      input.operationId,
      input.effectId,
      input.idempotencyKey,
      input.runId,
      input.operationKind,
      input.providerInstanceId ?? null,
      now,
    ],
  );
  const operation = getExternalOperationByEffectId(db, input.effectId);
  if (!operation) {
    throw new PersistedRecordError(
      `Prepared external operation is missing for effect ${input.effectId}`,
    );
  }
  if (
    operation.operationId !== input.operationId ||
    operation.idempotencyKey !== input.idempotencyKey ||
    operation.runId !== input.runId ||
    operation.operationKind !== input.operationKind
  ) {
    throw new PersistedRecordError(
      `External operation identity conflict for effect ${input.effectId}`,
    );
  }
  return operation;
}

export function getExternalOperationByEffectId(
  db: StoreDatabase,
  effectId: EffectId,
): ExternalOperation | undefined {
  const row = db
    .query("SELECT * FROM external_operations WHERE effect_id = ?")
    .get(effectId) as ExternalOperationRow | null;
  return row ? rowToExternalOperation(row) : undefined;
}

export function markExternalOperationDispatched(
  db: StoreDatabase,
  input: { readonly effectId: EffectId; readonly now?: number },
): ExternalOperation {
  return transitionExternalOperation(db, {
    effectId: input.effectId,
    allowedStates: ["prepared"],
    nextState: "dispatched",
    timestampColumn: "dispatched_at",
    now: input.now,
  });
}

export function observeExternalOperation(
  db: StoreDatabase,
  input: {
    readonly effectId: EffectId;
    readonly nativeReference?: string;
    readonly now?: number;
  },
): ExternalOperation {
  return transitionExternalOperation(db, {
    effectId: input.effectId,
    allowedStates: ["dispatched", "observed", "outcome_unknown"],
    nextState: "observed",
    timestampColumn: "observed_at",
    nativeReference: input.nativeReference,
    now: input.now,
  });
}

export function commitExternalOperation(
  db: StoreDatabase,
  input: { readonly effectId: EffectId; readonly now?: number },
): ExternalOperation {
  return transitionExternalOperation(db, {
    effectId: input.effectId,
    allowedStates: ["observed", "committed"],
    nextState: "committed",
    timestampColumn: "committed_at",
    now: input.now,
  });
}

export function markExternalOperationOutcomeUnknown(
  db: StoreDatabase,
  input: {
    readonly effectId: EffectId;
    readonly error: string;
    readonly now?: number;
  },
): ExternalOperation {
  return transitionExternalOperation(db, {
    effectId: input.effectId,
    allowedStates: ["prepared", "dispatched", "observed", "outcome_unknown"],
    nextState: "outcome_unknown",
    lastError: input.error,
    now: input.now,
  });
}

type TransitionInput = {
  readonly effectId: EffectId;
  readonly allowedStates: ReadonlyArray<ExternalOperationState>;
  readonly nextState: ExternalOperationState;
  readonly timestampColumn?: "dispatched_at" | "observed_at" | "committed_at";
  readonly nativeReference?: string;
  readonly lastError?: string;
  readonly now?: number;
};

function transitionExternalOperation(
  db: StoreDatabase,
  input: TransitionInput,
): ExternalOperation {
  const current = getExternalOperationByEffectId(db, input.effectId);
  if (!current) {
    throw new PersistedRecordError(
      `External operation is missing for effect ${input.effectId}`,
    );
  }
  if (!input.allowedStates.includes(current.state)) {
    throw new PersistedRecordError(
      `Cannot transition external operation ${input.effectId} from ${current.state} to ${input.nextState}`,
    );
  }
  if (current.state === input.nextState) return current;

  const now = input.now ?? Date.now();
  const assignments = ["state = ?"];
  const values: Array<string | number | null> = [input.nextState];
  if (input.timestampColumn) {
    assignments.push(`${input.timestampColumn} = COALESCE(${input.timestampColumn}, ?)`);
    values.push(now);
  }
  if (input.nativeReference !== undefined) {
    assignments.push("native_reference = ?");
    values.push(input.nativeReference);
  }
  if (input.lastError !== undefined) {
    assignments.push("last_error = ?");
    values.push(input.lastError);
  }
  values.push(input.effectId, current.state);
  const result = db.run(
    `UPDATE external_operations
     SET ${assignments.join(", ")}
     WHERE effect_id = ? AND state = ?`,
    values,
  );
  if (result.changes !== 1) {
    throw new PersistedRecordError(
      `External operation transition lost for effect ${input.effectId}`,
    );
  }
  const updated = getExternalOperationByEffectId(db, input.effectId);
  if (!updated) throw new PersistedRecordError(`External operation disappeared for effect ${input.effectId}`);
  return updated;
}

type ExternalOperationRow = {
  operation_id: string;
  effect_id: string;
  idempotency_key: string;
  run_id: string;
  operation_kind: string;
  state: string;
  provider_instance_id: string | null;
  native_reference: string | null;
  prepared_at: number;
  dispatched_at: number | null;
  observed_at: number | null;
  committed_at: number | null;
  last_error: string | null;
  schema_version: number;
};

function rowToExternalOperation(row: ExternalOperationRow): ExternalOperation {
  if (
    row.state !== "prepared" &&
    row.state !== "dispatched" &&
    row.state !== "observed" &&
    row.state !== "committed" &&
    row.state !== "outcome_unknown"
  ) {
    throw new PersistedRecordError(`Invalid external operation state: ${row.state}`);
  }
  if (row.schema_version !== 1) {
    throw new PersistedRecordError(`Unsupported external operation schema version: ${row.schema_version}`);
  }
  return {
    operationId: row.operation_id,
    effectId: row.effect_id as EffectId,
    idempotencyKey: row.idempotency_key,
    runId: row.run_id as RunId,
    operationKind: row.operation_kind,
    state: row.state,
    ...(row.provider_instance_id === null ? {} : { providerInstanceId: row.provider_instance_id }),
    ...(row.native_reference === null ? {} : { nativeReference: row.native_reference }),
    preparedAt: row.prepared_at,
    ...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at }),
    ...(row.observed_at === null ? {} : { observedAt: row.observed_at }),
    ...(row.committed_at === null ? {} : { committedAt: row.committed_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    schemaVersion: 1,
  };
}
