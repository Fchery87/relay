import type {
  CanonicalEventDraft,
  DurableEffect,
  EffectReactor,
  ReactorCommandDraft,
} from "@relay/contracts";

export function createDeterministicProviderReactor(input: {
  readonly text: string;
  readonly providerInstanceId?: string;
}): EffectReactor {
  const produce = async (
    effect: DurableEffect,
  ): Promise<ReadonlyArray<ReactorCommandDraft>> => {
    if (effect.intent.kind !== "provider.send_turn") {
      throw new Error(
        `Deterministic provider cannot handle ${effect.intent.kind}`,
      );
    }

    const providerInstanceId =
      (input.providerInstanceId ?? "provider-deterministic") as never;
    const base = {
      turnId: effect.intent.turnId,
      providerInstanceId,
      correlationId: `corr-${effect.effectId}` as never,
      causationId: effect.commandId as never,
    };
    const events: ReadonlyArray<CanonicalEventDraft> = [
      {
        ...base,
        eventId: `ev-${effect.effectId}-delta` as never,
        type: "assistant.delta",
        payload: { text: input.text },
      },
      {
        ...base,
        eventId: `ev-${effect.effectId}-assistant-completed` as never,
        type: "assistant.completed",
        payload: {},
      },
      {
        ...base,
        eventId: `ev-${effect.effectId}-turn-completed` as never,
        type: "turn.completed",
        payload: { summary: input.text },
      },
    ];

    return events.map((normalizedEvent) => ({
      type: "provider.event",
      payload: { providerInstanceId, normalizedEvent },
    }));
  };
  return {
    execute: produce,
    // The deterministic adapter has no hidden provider state, so replaying
    // its canonical result is its reconciliation behavior—not a new
    // external provider dispatch.
    recover: produce,
  };
}
