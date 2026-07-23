import type { CommandGateway } from "./convex-command-source";

// ---------------------------------------------------------------------------
// Fake command gateway — an in-memory stand-in for convex/commands/inbox.ts,
// mirroring its claim/lease/fencing/reclaim contract, for deterministic
// kill-point tests (lease expiry, lost completion, stale workers, redelivery
// after restart) without a live backend. Not for production use.
// ---------------------------------------------------------------------------

type FakeCommand = {
  commandId: string;
  correlationId: string;
  kind: string;
  payloadJson: string;
  runId?: string;
  status: "pending" | "claimed" | "completed" | "rejected";
  leaseOwner?: string;
  leaseGeneration: number;
  leaseExpiresAt?: number;
};

export type FakeCommandGatewayOptions = {
  /** Called before each `renewLease` resolves; return an Error to simulate lost renewal. */
  failRenewLease?: (commandId: string) => Error | undefined;
  /** Called before each `completeCommand` resolves; return an Error to simulate a lost/dropped completion response. */
  failCompleteCommand?: (commandId: string) => Error | undefined;
};

/**
 * A store shared across gateway instances lets tests simulate a daemon
 * restart: a new `KernelDaemon` bound to a fresh `FakeCommandGateway` that
 * points at the same backing `store` sees the same claimed-but-unfinished
 * commands the crashed instance left behind.
 */
export function createFakeCommandStore(): Map<string, FakeCommand> {
  return new Map();
}

export function createFakeCommandGateway(
  store: Map<string, FakeCommand>,
  options: FakeCommandGatewayOptions = {},
): CommandGateway & {
  readonly completeCalls: ReadonlyArray<{ commandId: string; leaseGeneration: number; status: string }>;
  /** Test-only: simulate another worker reclaiming a command mid-processing. */
  forceReclaim(commandId: string, newOwner: string): void;
  seed(input: { commandId: string; correlationId: string; kind: string; payloadJson: string; runId?: string }): void;
} {
  const completeCalls: Array<{ commandId: string; leaseGeneration: number; status: string }> = [];
  let counter = 0;

  return {
    get completeCalls() {
      return completeCalls;
    },
    seed(input) {
      store.set(input.commandId, {
        commandId: input.commandId,
        correlationId: input.correlationId,
        kind: input.kind,
        payloadJson: input.payloadJson,
        runId: input.runId,
        status: "pending",
        leaseGeneration: 0,
      });
    },
    forceReclaim(commandId, newOwner) {
      const cmd = store.get(commandId);
      if (!cmd) throw new Error(`Unknown command ${commandId}`);
      cmd.leaseGeneration += 1;
      cmd.leaseOwner = newOwner;
      cmd.leaseExpiresAt = Date.now() + 60_000;
    },
    async submitCommand(input) {
      const commandId = input.commandId || `fake-cmd-${++counter}`;
      store.set(commandId, {
        commandId,
        correlationId: input.correlationId,
        kind: input.kind,
        payloadJson: input.payloadJson,
        status: "pending",
        leaseGeneration: 0,
      });
      return commandId;
    },
    async claimBatch(input) {
      const now = Date.now();
      const claimed: FakeCommand[] = [];
      for (const cmd of store.values()) {
        if (claimed.length >= input.limit) break;
        const reclaimable = cmd.status === "claimed" && (cmd.leaseExpiresAt ?? 0) <= now;
        if (cmd.status === "pending" || reclaimable) {
          cmd.status = "claimed";
          cmd.leaseGeneration += 1;
          cmd.leaseOwner = input.deviceToken;
          cmd.leaseExpiresAt = now + input.leaseDurationMs;
          claimed.push(cmd);
        }
      }
      return claimed.map((cmd) => ({
        commandId: cmd.commandId,
        correlationId: cmd.correlationId,
        externalCommandId: cmd.commandId,
        kind: cmd.kind,
        leaseGeneration: cmd.leaseGeneration,
        payloadJson: cmd.payloadJson,
        runId: cmd.runId,
      }));
    },
    async renewLease(input) {
      const failure = options.failRenewLease?.(input.commandId);
      if (failure) throw failure;
      const cmd = store.get(input.commandId);
      if (!cmd) throw new Error("Command not found");
      if (cmd.status !== "claimed") throw new Error("Command is not claimed");
      if (cmd.leaseGeneration !== input.leaseGeneration) throw new Error("Stale lease generation — command was reclaimed");
      cmd.leaseExpiresAt = Date.now() + input.leaseDurationMs;
    },
    async completeCommand(input) {
      completeCalls.push({ commandId: input.commandId, leaseGeneration: input.leaseGeneration, status: input.status });
      const failure = options.failCompleteCommand?.(input.commandId);
      if (failure) throw failure;
      const cmd = store.get(input.commandId);
      if (!cmd) throw new Error("Command not found");
      if (cmd.status === "completed" || cmd.status === "rejected") throw new Error("Command already terminal");
      if (cmd.leaseGeneration !== input.leaseGeneration) throw new Error("Stale lease generation — command was reclaimed");
      cmd.status = input.status;
    },
  };
}
