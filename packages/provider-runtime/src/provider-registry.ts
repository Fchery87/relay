import type { ProviderInstanceId, RunId } from "@relay/contracts";
import type { ProviderDriver, ProviderSession, ProviderSessionScope } from "./provider-driver";

export class ProviderSessionRegistry {
  private readonly drivers = new Map<string, ProviderDriver<unknown>>();
  private readonly sessions = new Map<string, ProviderSession>();

  register<T>(providerInstanceId: ProviderInstanceId, driver: ProviderDriver<T>): void {
    if (this.drivers.has(providerInstanceId)) throw new Error(`Provider already registered: ${providerInstanceId}`);
    this.drivers.set(providerInstanceId, driver as ProviderDriver<unknown>);
  }

  async create<T>(providerInstanceId: ProviderInstanceId, config: T, scope: ProviderSessionScope): Promise<ProviderSession> {
    if (scope.providerInstanceId !== providerInstanceId || scope.runId.length === 0) throw new Error("Provider session scope mismatch");
    const driver = this.drivers.get(providerInstanceId);
    if (!driver) throw new Error(`Provider not registered: ${providerInstanceId}`);
    const key = this.key(scope.runId, providerInstanceId);
    if (this.sessions.has(key)) throw new Error(`Provider session already exists: ${key}`);
    const session = await driver.create(config, freezeScope(scope));
    this.sessions.set(key, session);
    return session;
  }

  get(runId: RunId, providerInstanceId: ProviderInstanceId): ProviderSession | undefined { return this.sessions.get(this.key(runId, providerInstanceId)); }
  delete(runId: RunId, providerInstanceId: ProviderInstanceId): boolean { return this.sessions.delete(this.key(runId, providerInstanceId)); }
  private key(runId: RunId, providerInstanceId: ProviderInstanceId): string { return `${runId}\0${providerInstanceId}`; }
}

function freezeScope(scope: ProviderSessionScope): ProviderSessionScope {
  return Object.freeze({ ...scope, capabilities: new Set(scope.capabilities) });
}
