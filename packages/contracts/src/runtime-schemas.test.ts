import { describe, expect, test } from "bun:test";
import { assertCommandSchema, CommandSchemaError } from "./runtime-schemas";

function providerCommand(normalizedEvent: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    commandId: "cmd-provider-event",
    type: "provider.event",
    runId: "run-1",
    correlationId: "corr-provider-event",
    actor: { kind: "provider", id: "provider-1" },
    issuedAt: 1,
    payload: {
      providerInstanceId: "provider-1",
      normalizedEvent,
    },
  };
}

describe("provider event ingress", () => {
  test("requires a turn ID for turn-scoped output", () => {
    expect(() =>
      assertCommandSchema(providerCommand({
        eventId: "event-1",
        type: "assistant.delta",
        correlationId: "corr-event-1",
        payload: { text: "unscoped" },
      })),
    ).toThrow(CommandSchemaError);
  });

  test("accepts non-turn-scoped provider events without a turn ID", () => {
    expect(() =>
      assertCommandSchema(providerCommand({
        eventId: "event-2",
        type: "usage.recorded",
        correlationId: "corr-event-2",
        payload: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
          modelId: "test",
        },
      })),
    ).not.toThrow();
  });

  test("rejects unknown event types and malformed known payloads", () => {
    expect(() =>
      assertCommandSchema(providerCommand({
        eventId: "event-unknown",
        type: "provider.native.secret",
        correlationId: "corr-event-unknown",
        payload: {},
      })),
    ).toThrow("Unknown canonical event type");
    expect(() =>
      assertCommandSchema(providerCommand({
        eventId: "event-malformed",
        type: "usage.recorded",
        correlationId: "corr-event-malformed",
        payload: {
          inputTokens: -1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
          modelId: "test",
        },
      })),
    ).toThrow("non-negative finite number");
    expect(() =>
      assertCommandSchema(providerCommand({
        eventId: "event-invalid-optional",
        type: "provider.session.started",
        correlationId: "corr-event-invalid-optional",
        payload: {
          providerInstanceId: "provider-1",
          providerThreadId: 123,
        },
      })),
    ).toThrow("providerThreadId");
  });
});
