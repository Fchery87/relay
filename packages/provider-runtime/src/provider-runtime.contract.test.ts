import { expect, test } from "bun:test";
import type { ProviderDriver, ProviderSession, ProviderSessionScope, ScopedProviderEvent } from "./provider-driver";
import { runProviderRuntimeContract, assertScopedEvent } from "./provider-runtime.contract";

function fixture() {
  const scope: ProviderSessionScope = Object.freeze({
    runId: "run-contract" as never,
    providerInstanceId: "provider-contract" as never,
    workspacePath: "/tmp/relay-contract",
    permissionProfile: "read-only",
    capabilities: new Set(["turns"]),
  });
  const events: ScopedProviderEvent[] = [];
  let generation = 0;
  const driver: ProviderDriver<unknown> = {
    async inspect() { return { available: true, capabilities: ["turns"] }; },
    async create(_config, createdScope) {
      if (createdScope.runId !== scope.runId) throw new Error("scope changed");
      const session: ProviderSession = {
        scope: createdScope,
        async start() { generation = 1; return { runId: scope.runId, providerInstanceId: scope.providerInstanceId, providerThreadId: "thread-1", processGeneration: generation }; },
        async resume(receipt) { if (receipt.processGeneration !== generation) throw new Error("stale receipt"); },
        async send(input) {
          const receipt = { runId: input.runId, turnId: input.turnId, providerThreadId: "thread-1", nativeTurnId: "native-1", processGeneration: generation };
          events.push({ runId: input.runId, providerInstanceId: scope.providerInstanceId, turnId: input.turnId, identity: { providerThreadId: "thread-1", nativeTurnId: "native-1", processGeneration: generation, nativeEventId: input.commandId }, type: "turn.started", payload: {} });
          return receipt;
        },
        async steer() {}, async interrupt() {}, async resolveRequest() {}, async stop() {},
        async *events(signal) { for (const event of events) { if (signal?.aborted) return; assertScopedEvent(event, scope); yield event; } },
      };
      return session;
    },
  };
  return { driver, scope, ids: { runId: scope.runId, providerInstanceId: scope.providerInstanceId, turnId: "turn-contract" as never } };
}

test("provider runtime fixture satisfies shared lifecycle contract", async () => {
  await runProviderRuntimeContract(async () => fixture());
});

test("provider runtime rejects cross-session events", () => {
  expect(() => assertScopedEvent({ runId: "foreign" as never, providerInstanceId: "provider-contract" as never, identity: { providerThreadId: "thread", processGeneration: 1, nativeEventId: "event" } }, fixture().scope)).toThrow("crossed session scope");
});
