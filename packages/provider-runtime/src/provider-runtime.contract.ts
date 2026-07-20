import type { ProviderDriver, ProviderSessionScope } from "./provider-driver";
import type { ProviderInstanceId, RunId, TurnId } from "@relay/contracts";

export type ProviderContractFixture = Readonly<{
  driver: ProviderDriver<unknown>;
  scope: ProviderSessionScope;
  ids: { runId: RunId; providerInstanceId: ProviderInstanceId; turnId: TurnId };
}>;

export async function runProviderRuntimeContract(create: () => Promise<ProviderContractFixture>): Promise<void> {
  const fixture = await create();
  const session = await fixture.driver.create({}, fixture.scope);
  const started = await session.start();
  if (started.runId !== fixture.ids.runId) throw new Error("session start changed run scope");
  await session.resume(started);
  const receipt = await session.send({ runId: fixture.ids.runId, turnId: fixture.ids.turnId, prompt: "hello", commandId: "command-1" });
  if (receipt.turnId !== fixture.ids.turnId) throw new Error("turn identity was not preserved");
  await session.steer({ runId: fixture.ids.runId, turnId: fixture.ids.turnId, steering: "continue" });
  await session.interrupt({ runId: fixture.ids.runId, turnId: fixture.ids.turnId, reason: "test" });
  await session.resolveRequest({ runId: fixture.ids.runId, requestId: "request-1", resolution: "deny" });
  await session.stop("test");
}

export function assertScopedEvent(event: { runId: RunId; providerInstanceId: ProviderInstanceId; identity: { providerThreadId: string; processGeneration: number; nativeEventId: string } }, scope: ProviderSessionScope): void {
  if (event.runId !== scope.runId || event.providerInstanceId !== scope.providerInstanceId) throw new Error("provider event crossed session scope");
  if (!event.identity.providerThreadId || event.identity.processGeneration < 1 || !event.identity.nativeEventId) throw new Error("provider event is missing native identity");
}
