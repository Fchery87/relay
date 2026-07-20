import { ClientRuntime, type ClientConfig, type ClientState } from "@relay/client-runtime";
export function createCanonicalRuntime(config: ClientConfig): ClientRuntime { return new ClientRuntime(config); }
export type CanonicalClientState = ClientState;
