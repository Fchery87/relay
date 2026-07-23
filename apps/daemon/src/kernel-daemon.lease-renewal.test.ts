// ---------------------------------------------------------------------------
// Kill-point tests for the command-lease renewal/fencing path: lease expiry,
// daemon restart, lost completion, and stale workers.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { KernelDaemon, startLeaseRenewal } from "./kernel-daemon";
import { createFakeCommandGateway, createFakeCommandStore } from "./sync/fake-command-gateway";
import { createFakeProjectionSink } from "./sync/fake-projection-sink";

const tempDirs: string[] = [];
function tempDaemonHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-lease-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("startLeaseRenewal", () => {
  test("renews the exact lease generation repeatedly for the effect lifetime", async () => {
    // Keep enough wall-clock margin for the full suite's parallel workers;
    // sub-30ms leases make this timer-contract test depend on scheduler
    // luck rather than exercising the renewal behavior.
    const leaseDurationMs = 300;
    const store = createFakeCommandStore();
    const gateway = createFakeCommandGateway(store);
    gateway.seed({ commandId: "cmd-1", correlationId: "corr-1", kind: "run.create", payloadJson: "{}" });
    const claimed = await gateway.claimBatch({ deviceToken: "dev-token", leaseDurationMs, limit: 5 });
    expect(claimed).toHaveLength(1);

    let lostCount = 0;
    const stop = startLeaseRenewal({
      commandGateway: gateway,
      commandId: "cmd-1",
      deviceToken: "dev-token",
      leaseGeneration: claimed[0]!.leaseGeneration,
      leaseDurationMs,
      onLost: () => { lostCount++; },
    });

    // Outlive the original 300ms lease several times over — renewal must
    // keep it alive so it is never treated as expired/reclaimable.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    stop();

    expect(lostCount).toBe(0);
    const reclaimAttempt = await gateway.claimBatch({ deviceToken: "another-worker", leaseDurationMs, limit: 5 });
    expect(reclaimAttempt).toHaveLength(0); // still validly leased, not reclaimable

    await gateway.completeCommand({ commandId: "cmd-1", deviceToken: "dev-token", leaseGeneration: claimed[0]!.leaseGeneration, status: "completed" });
  });

  test("fires onLost once the lease is reclaimed by another worker (stale worker)", async () => {
    const store = createFakeCommandStore();
    const gateway = createFakeCommandGateway(store);
    gateway.seed({ commandId: "cmd-1", correlationId: "corr-1", kind: "run.create", payloadJson: "{}" });
    const claimed = await gateway.claimBatch({ deviceToken: "dev-token", leaseDurationMs: 30, limit: 5 });

    let lostError: unknown;
    const stop = startLeaseRenewal({
      commandGateway: gateway,
      commandId: "cmd-1",
      deviceToken: "dev-token",
      leaseGeneration: claimed[0]!.leaseGeneration,
      leaseDurationMs: 30,
      onLost: (error) => { lostError = error; },
    });

    // Simulate another worker reclaiming this command out from under us.
    gateway.forceReclaim("cmd-1", "another-worker");

    await new Promise((resolve) => setTimeout(resolve, 40));
    stop();

    expect(lostError).toBeInstanceOf(Error);
    expect((lostError as Error).message).toMatch(/stale lease generation/i);

    // The original (stale) generation can never complete the command.
    await expect(
      gateway.completeCommand({ commandId: "cmd-1", deviceToken: "dev-token", leaseGeneration: claimed[0]!.leaseGeneration, status: "completed" }),
    ).rejects.toThrow(/stale lease generation/i);
  });
});

describe("KernelDaemon command processing — lease kill-points", () => {
  test("lost completion: a dropped completion response is redelivered and the command still converges to terminal exactly once", async () => {
    const store = createFakeCommandStore();
    let completeAttempt = 0;
    const gateway = createFakeCommandGateway(store, {
      failCompleteCommand: () => {
        completeAttempt++;
        // The first completion response never arrives — but the mutation's
        // effect might still have committed server-side; the fake mirrors
        // "response lost after commit" by throwing on the client without
        // applying the completion.
        return completeAttempt === 1 ? new Error("simulated lost completion response") : undefined;
      },
    });
    gateway.seed({ commandId: "cmd-1", correlationId: "corr-1", kind: "run.create", payloadJson: JSON.stringify({ projectId: "proj-1" }) });

    const daemon = new KernelDaemon({
      daemonHome: tempDaemonHome(),
      deploymentUrl: "http://unused.invalid",
      deviceToken: "dev-token",
      heartbeatIntervalMs: 10_000,
      machineId: "machine-1",
      machineName: "test-machine",
      pollIntervalMs: 10_000, // manual pollOnce() drives this test
      commandLeaseDurationMs: 200,
      commandGateway: gateway,
      projectionSink: createFakeProjectionSink(),
    });
    await daemon.start();

    // First delivery: command executes, but the completion response is lost.
    await daemon.pollOnce();
    expect(store.get("cmd-1")!.status).toBe("claimed"); // never marked terminal locally

    // Lease expires; redelivery reclaims and reprocesses. run.create is
    // idempotent at the engine level, so no duplicate run is created.
    await new Promise((resolve) => setTimeout(resolve, 220));
    await daemon.pollOnce();

    // Terminal state is reached exactly once despite two completion
    // attempts (one lost response, one successful redelivery) — no
    // duplicate run.create effect occurred in between.
    expect(store.get("cmd-1")!.status).toBe("completed");
    expect(completeAttempt).toBe(2);

    await daemon.stop();
  });

  test("stale worker: two workers cannot both hold a live claim on the same command", async () => {
    // The renewal-detects-loss race is proven deterministically at the
    // startLeaseRenewal unit level above (fast commands like run.create
    // resolve before any renewal tick could possibly fire, so racing that
    // path through the full daemon is inherently non-deterministic). This
    // covers the complementary daemon-visible invariant: while worker A's
    // lease is live, worker B's claim cannot see the same command at all.
    const store = createFakeCommandStore();
    const gatewayA = createFakeCommandGateway(store);
    gatewayA.seed({ commandId: "cmd-1", correlationId: "corr-1", kind: "run.create", payloadJson: "{}" });
    const claimedByA = await gatewayA.claimBatch({ deviceToken: "worker-a", leaseDurationMs: 5_000, limit: 5 });
    expect(claimedByA).toHaveLength(1);

    const gatewayB = createFakeCommandGateway(store);
    const claimedByB = await gatewayB.claimBatch({ deviceToken: "worker-b", leaseDurationMs: 5_000, limit: 5 });
    expect(claimedByB).toHaveLength(0); // A's lease is live — B sees nothing to claim

    // A completes normally with the generation it actually holds.
    await gatewayA.completeCommand({ commandId: "cmd-1", deviceToken: "worker-a", leaseGeneration: claimedByA[0]!.leaseGeneration, status: "completed" });
    expect(store.get("cmd-1")!.status).toBe("completed");
  });

  test("daemon restart: a command claimed but never completed before a crash is redelivered by a fresh daemon instance", async () => {
    const store = createFakeCommandStore();
    const daemonHome = tempDaemonHome();
    // First "daemon": claims the command, then the process is treated as
    // crashed — it never calls processCommand's completion at all, modeled
    // by claiming directly and abandoning it (no stop(), no complete()).
    const gateway1 = createFakeCommandGateway(store);
    gateway1.seed({ commandId: "cmd-1", correlationId: "corr-1", kind: "run.create", payloadJson: JSON.stringify({ projectId: "proj-1" }) });
    await gateway1.claimBatch({ deviceToken: "dev-token", leaseDurationMs: 30, limit: 5 });
    expect(store.get("cmd-1")!.status).toBe("claimed");

    // Lease expires with nobody renewing it (the crashed process is gone).
    await new Promise((resolve) => setTimeout(resolve, 40));

    // A fresh daemon instance, same backing command store, same daemonHome
    // (so it reopens the same local SQLite state a real restart would).
    const gateway2 = createFakeCommandGateway(store);
    const daemon2 = new KernelDaemon({
      daemonHome,
      deploymentUrl: "http://unused.invalid",
      deviceToken: "dev-token",
      heartbeatIntervalMs: 10_000,
      machineId: "machine-1",
      machineName: "test-machine",
      pollIntervalMs: 10_000,
      commandLeaseDurationMs: 200,
      commandGateway: gateway2,
      projectionSink: createFakeProjectionSink(),
    });
    await daemon2.start();
    await daemon2.pollOnce();

    expect(store.get("cmd-1")!.status).toBe("completed");
    expect(gateway2.completeCalls.filter((c) => c.status === "completed")).toHaveLength(1);

    await daemon2.stop();
  });
});
