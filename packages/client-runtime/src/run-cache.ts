import type { ClientState } from "./client-runtime";
export class RunCache { private readonly states = new Map<string, ClientState>(); get(runId: string): ClientState | undefined { return this.states.get(runId); } set(state: ClientState): void { this.states.set(state.runId as string, state); } delete(runId: string): boolean { return this.states.delete(runId); } }
