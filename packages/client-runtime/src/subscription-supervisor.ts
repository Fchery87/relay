import type { ClientRuntime, ClientState } from "./client-runtime";
export type SubscriptionStatus = Readonly<{ connected: boolean; fresh: boolean; lastError?: string; attempt: number }>;
export class SubscriptionSupervisor {
  private stopped = false;
  private status: SubscriptionStatus = { connected: false, fresh: false, attempt: 0 };
  constructor(private readonly runtime: ClientRuntime, private readonly backoffMs = 250) {}
  async connect(runId: string): Promise<ClientState> { this.stopped = false; try { const state = await this.runtime.connect(runId); this.status = { connected: true, fresh: true, attempt: 0 }; return state; } catch (error) { this.status = { connected: false, fresh: false, attempt: 1, lastError: error instanceof Error ? error.message : String(error) }; throw error; } }
  async resume(runId: string): Promise<ClientState> { if (this.stopped) throw new Error("Subscription supervisor stopped"); try { const state = await this.runtime.resume(runId); this.status = { connected: true, fresh: true, attempt: 0 }; return state; } catch (error) { this.status = { connected: false, fresh: false, attempt: this.status.attempt + 1, lastError: error instanceof Error ? error.message : String(error) }; await new Promise(resolve => setTimeout(resolve, this.backoffMs * Math.min(this.status.attempt, 8))); throw error; } }
  stop(): void { this.stopped = true; this.status = { connected: false, fresh: false, attempt: this.status.attempt }; }
  getStatus(): SubscriptionStatus { return this.status; }
}
