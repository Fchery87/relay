import { expect, test } from "bun:test";

import { openMemoryStore } from "./database";
import {
  commitExternalOperation,
  getExternalOperationByEffectId,
  markExternalOperationDispatched,
  markExternalOperationOutcomeUnknown,
  observeExternalOperation,
  prepareExternalOperation,
} from "./external-operation-store";

test("external operation journal persists a prepared provider turn before dispatch", () => {
  const db = openMemoryStore();

  const prepared = prepareExternalOperation(db, {
    effectId: "effect-turn-1" as never,
    idempotencyKey: "relay:effect-turn-1",
    operationId: "operation-turn-1",
    operationKind: "provider.send_turn",
    providerInstanceId: "provider-codex",
    runId: "run-1" as never,
    now: 10,
  });

  expect(prepared).toMatchObject({
    effectId: "effect-turn-1",
    idempotencyKey: "relay:effect-turn-1",
    operationId: "operation-turn-1",
    operationKind: "provider.send_turn",
    preparedAt: 10,
    providerInstanceId: "provider-codex",
    runId: "run-1",
    schemaVersion: 1,
    state: "prepared",
  });
  expect(getExternalOperationByEffectId(db, "effect-turn-1" as never)).toEqual(prepared);
});

test("external operation journal is idempotent and rejects conflicting identity", () => {
  const db = openMemoryStore();
  const input = {
    effectId: "effect-turn-identity" as never,
    idempotencyKey: "relay:effect-turn-identity",
    operationId: "operation-turn-identity",
    operationKind: "provider.send_turn",
    runId: "run-identity" as never,
    now: 10,
  };

  expect(prepareExternalOperation(db, input)).toMatchObject({ state: "prepared" });
  expect(prepareExternalOperation(db, { ...input, now: 20 })).toMatchObject({ preparedAt: 10 });
  expect(() => prepareExternalOperation(db, { ...input, operationId: "operation-other" }))
    .toThrow("External operation identity conflict");
});

test("external operation journal only advances from dispatched through observed to committed", () => {
  const db = openMemoryStore();
  const effectId = "effect-turn-state" as never;
  prepareExternalOperation(db, {
    effectId,
    idempotencyKey: "relay:effect-turn-state",
    operationId: "operation-turn-state",
    operationKind: "provider.send_turn",
    runId: "run-state" as never,
    now: 10,
  });

  expect(() => observeExternalOperation(db, { effectId, now: 11 }))
    .toThrow("from prepared to observed");
  expect(markExternalOperationDispatched(db, { effectId, now: 12 })).toMatchObject({
    dispatchedAt: 12,
    state: "dispatched",
  });
  expect(observeExternalOperation(db, {
    effectId,
    nativeReference: "thread-1/turn-2",
    now: 13,
  })).toMatchObject({
    nativeReference: "thread-1/turn-2",
    observedAt: 13,
    state: "observed",
  });
  expect(commitExternalOperation(db, { effectId, now: 14 })).toMatchObject({
    committedAt: 14,
    state: "committed",
  });
  expect(() => markExternalOperationDispatched(db, { effectId, now: 15 }))
    .toThrow("from committed to dispatched");
});

test("external operation journal makes an unreconciled dispatch durably outcome unknown", () => {
  const db = openMemoryStore();
  const effectId = "effect-turn-unknown" as never;
  prepareExternalOperation(db, {
    effectId,
    idempotencyKey: "relay:effect-turn-unknown",
    operationId: "operation-turn-unknown",
    operationKind: "provider.send_turn",
    runId: "run-unknown" as never,
    now: 10,
  });
  markExternalOperationDispatched(db, { effectId, now: 11 });

  expect(markExternalOperationOutcomeUnknown(db, {
    effectId,
    error: "provider cannot query the relay idempotency key",
    now: 12,
  })).toMatchObject({
    dispatchedAt: 11,
    lastError: "provider cannot query the relay idempotency key",
    state: "outcome_unknown",
  });
});
