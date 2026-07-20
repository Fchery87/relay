export const KILL_POINTS = ["remote.claim", "local.persist", "receipt.check", "event.append", "effect.claim", "provider.start", "provider.thread", "provider.stream", "provider.approval", "sandbox.command", "checkpoint.ref", "outbox.publish", "outbox.ack", "shutdown"] as const;
export type KillPoint = typeof KILL_POINTS[number];
export class KillPointController { constructor(private readonly target?: KillPoint) {} hit(point: KillPoint): void { if (point === this.target) throw new Error(`Injected crash at ${point}`); } }
