import type { ProviderInstanceId, RunId, TurnId } from "@relay/contracts";

export type ProviderSessionScope = Readonly<{
  runId: RunId;
  providerInstanceId: ProviderInstanceId;
  workspacePath: string;
  permissionProfile: "read-only" | "workspace-write" | "full-access";
  capabilities: ReadonlySet<string>;
}>;

export type ProviderAvailability = Readonly<{
  available: boolean;
  providerInstanceId?: ProviderInstanceId;
  version?: string;
  capabilities: readonly string[];
  reason?: string;
}>;

export type ProviderDriver<TConfig = unknown> = Readonly<{
  inspect(config: unknown): Promise<ProviderAvailability>;
  create(config: TConfig, scope: ProviderSessionScope): Promise<ProviderSession>;
}>;

export type ProviderTurnInput = Readonly<{
  runId: RunId;
  turnId: TurnId;
  prompt: string;
  commandId: string;
}>;

export type ProviderSteerInput = Readonly<{ runId: RunId; turnId: TurnId; steering: string }>;
export type ProviderInterruptInput = Readonly<{ runId: RunId; turnId: TurnId; reason: string }>;
export type ProviderRequestResolution = Readonly<{
  runId: RunId;
  requestId: string;
  resolution: "allow" | "deny";
  payload?: unknown;
}>;

export type ProviderSessionReceipt = Readonly<{
  runId: RunId;
  providerInstanceId: ProviderInstanceId;
  providerThreadId: string;
  processGeneration: number;
}>;

export type ProviderTurnReceipt = Readonly<{
  runId: RunId;
  turnId: TurnId;
  providerThreadId: string;
  nativeTurnId: string;
  processGeneration: number;
}>;

export type ProviderNativeIdentity = Readonly<{
  providerThreadId: string;
  nativeTurnId?: string;
  processGeneration: number;
  nativeEventId: string;
}>;

export type ScopedProviderEvent = Readonly<{
  runId: RunId;
  providerInstanceId: ProviderInstanceId;
  turnId?: TurnId;
  identity: ProviderNativeIdentity;
  type: string;
  payload: unknown;
}>;

export interface ProviderSession {
  readonly scope: ProviderSessionScope;
  start(): Promise<ProviderSessionReceipt>;
  resume(receipt: ProviderSessionReceipt): Promise<void>;
  send(input: ProviderTurnInput): Promise<ProviderTurnReceipt>;
  steer(input: ProviderSteerInput): Promise<void>;
  interrupt(input: ProviderInterruptInput): Promise<void>;
  resolveRequest(input: ProviderRequestResolution): Promise<void>;
  stop(reason: string): Promise<void>;
  events(signal?: AbortSignal): AsyncIterable<ScopedProviderEvent>;
}

export class ProviderProcessLostError extends Error {
  readonly code = "provider_process_lost" as const;
  constructor(message = "Provider process lost") { super(message); this.name = "ProviderProcessLostError"; }
}
