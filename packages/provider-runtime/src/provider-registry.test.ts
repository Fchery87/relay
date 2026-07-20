import { expect, test } from "bun:test";
import { ProviderSessionRegistry } from "./provider-registry";

test("registry isolates sessions by provider instance and run", async () => {
  const registry = new ProviderSessionRegistry();
  const driver = { inspect: async () => ({ available: true, capabilities: [] }), create: async (_: unknown, scope: any) => ({ scope, start: async () => ({ runId: scope.runId, providerInstanceId: scope.providerInstanceId, providerThreadId: "thread", processGeneration: 1 }), resume: async () => {}, send: async (i: any) => ({ ...i, providerThreadId: "thread", nativeTurnId: "turn", processGeneration: 1 }), steer: async () => {}, interrupt: async () => {}, resolveRequest: async () => {}, stop: async () => {}, events: async function* () {} }) };
  registry.register("provider-a" as never, driver);
  const scope = { runId: "run-a" as never, providerInstanceId: "provider-a" as never, workspacePath: "/tmp", permissionProfile: "read-only" as const, capabilities: new Set<string>() };
  const session = await registry.create("provider-a" as never, {}, scope);
  expect(registry.get(scope.runId, scope.providerInstanceId)).toBe(session);
  expect(() => registry.register("provider-a" as never, driver)).toThrow("already registered");
});
