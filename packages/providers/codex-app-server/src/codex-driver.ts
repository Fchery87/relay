import type { ProviderDriver, ProviderAvailability, ProviderSession, ProviderSessionReceipt, ProviderSessionScope, ProviderTurnInput, ProviderTurnReceipt, ProviderSteerInput, ProviderInterruptInput, ProviderRequestResolution, ScopedProviderEvent } from "@relay/provider-runtime";
import { createCodexSessionAdapter, type SessionAdapterConfig } from "./codex-session-adapter";

/**
 * The driver deliberately exposes the durable request resolver. Without it,
 * Codex server-initiated approvals, dynamic tools, and MCP elicitations would
 * be rejected at the provider boundary instead of entering Relay governance.
 */
export type CodexDriverConfig = Omit<SessionAdapterConfig, "onEvent">;
export const codexDriver: ProviderDriver<CodexDriverConfig> = {
  async inspect(config: unknown): Promise<ProviderAvailability> {
    if (!config || typeof config !== "object") return { available: false, capabilities: [], reason: "invalid configuration" };
    return { available: true, capabilities: ["turns", "steering", "interrupt", "approval"] };
  },
  async create(config: CodexDriverConfig, scope: ProviderSessionScope): Promise<ProviderSession> {
    const adapter = createCodexSessionAdapter({
      ...config,
      onRequest: config.onRequest ?? (async ({ method, params }) => ({ error: { code: -32601, message: `No durable resolver registered for ${method}`, data: params } })),
    });
    let receipt: ProviderSessionReceipt | undefined;
    const queue: ScopedProviderEvent[] = [];
    let generation = 1;
    const unsub = adapter.onEvent((event) => { queue.push({ runId: scope.runId, providerInstanceId: scope.providerInstanceId, identity: { providerThreadId: adapter.activeThreadId ?? "unknown", nativeTurnId: event.providerTurnId, processGeneration: generation, nativeEventId: `${event.type}:${event.providerTurnId ?? "none"}:${Date.now()}` }, type: event.type, payload: event.payload }); });
    return {
      scope,
      async start() { const result = await adapter.startThread({ cwd: scope.workspacePath }); const threadId = (result as any)?.thread?.id; if (!threadId) throw new Error("Codex did not return thread identity"); receipt = { runId: scope.runId, providerInstanceId: scope.providerInstanceId, providerThreadId: threadId, processGeneration: generation }; return receipt; },
      async resume(next) { if (next.runId !== scope.runId || next.providerInstanceId !== scope.providerInstanceId) throw new Error("Provider receipt scope mismatch"); await adapter.resumeThread(next.providerThreadId, { cwd: scope.workspacePath }); receipt = next; },
      async send(input: ProviderTurnInput): Promise<ProviderTurnReceipt> { if (!receipt || input.runId !== scope.runId) throw new Error("Provider session is not started"); const result = await adapter.startTurn(receipt.providerThreadId, input.prompt); const nativeTurnId = (result as any)?.turn?.id; if (!nativeTurnId) throw new Error("Codex did not return turn identity"); return { runId: scope.runId, turnId: input.turnId, providerThreadId: receipt.providerThreadId, nativeTurnId, processGeneration: generation }; },
      async steer(input: ProviderSteerInput) { await adapter.steerTurn(receipt?.providerThreadId ?? "", input.steering); },
      async interrupt(input: ProviderInterruptInput) { await adapter.interruptTurn(receipt?.providerThreadId ?? "", input.reason); },
      async resolveRequest(input: ProviderRequestResolution) { adapter.transport.respond(input.requestId, input.payload ?? { resolution: input.resolution }); },
      async stop() { unsub(); adapter.close(); generation++; },
      async *events(signal?: AbortSignal) { while (!signal?.aborted) { const event = queue.shift(); if (event) yield event; else await new Promise(resolve => setTimeout(resolve, 10)); } },
    };
  },
};
