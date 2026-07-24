import type { DurableEffect, EffectReactor, ReactorCommandDraft, ReactorRegistry } from "@relay/contracts";
import type { ProviderSessionRegistry } from "@relay/provider-runtime";

/** Bridges durable provider effects to scoped sessions; all results re-enter the kernel as commands. */
export function createProviderReactors(sessions: ProviderSessionRegistry): ReactorRegistry {
  const session = (effect: DurableEffect) => {
    const provider = effect.intent.kind === "provider.start_session" || effect.intent.kind === "provider.resume_session" ? effect.intent.providerInstanceId : "provider-deterministic";
    if (!provider) throw new Error(`Provider effect missing provider instance: ${effect.effectId}`);
    const found = sessions.get(effect.runId, provider as never);
    if (!found) throw new Error(`Provider session not found for run ${effect.runId}`);
    return found;
  };
  const execute = async (effect: DurableEffect, context: { signal: AbortSignal }): Promise<ReadonlyArray<ReactorCommandDraft>> => {
    const provider = session(effect); if (context.signal.aborted) throw new Error("Provider effect cancelled");
    switch (effect.intent.kind) {
      case "provider.send_turn": await provider.send({ runId: effect.runId, turnId: effect.intent.turnId, prompt: effect.intent.prompt, commandId: effect.commandId }); break;
      case "provider.steer_turn": await provider.steer({ runId: effect.runId, turnId: effect.intent.turnId, steering: effect.intent.steering }); break;
      case "provider.interrupt_turn": await provider.interrupt({ runId: effect.runId, turnId: effect.intent.turnId, reason: effect.intent.reason }); break;
      case "provider.resolve_approval": await provider.resolveRequest({ runId: effect.runId, requestId: effect.intent.approvalId, resolution: effect.intent.resolution }); break;
      case "provider.stop_session": await provider.stop("kernel effect"); break;
      default: return [];
    }
    return [];
  };
  const reconcile = async (effect: DurableEffect, context: { signal: AbortSignal }): Promise<ReadonlyArray<ReactorCommandDraft>> => {
    if (context.signal.aborted) throw new Error("Provider reconciliation cancelled");
    // Scoped adapters currently expose no provider-neutral read operation.
    // Returning no result preserves the dispatched operation for the caller's
    // durable reconciliation policy rather than issuing the native command a
    // second time.
    const provider = session(effect);
    void provider;
    return [];
  };
  const reactor: EffectReactor = { execute, recover: reconcile };
  return { "provider.start_session": reactor, "provider.resume_session": reactor, "provider.send_turn": reactor, "provider.steer_turn": reactor, "provider.interrupt_turn": reactor, "provider.resolve_approval": reactor, "provider.stop_session": reactor };
}
