import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api, internal } from "./_generated/api";
import { digestSecret } from "./auth_helpers";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function createAuthenticatedUser(t: ReturnType<typeof convexTest>) {
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  return t.withIdentity({ subject: `${userId}|session` });
}

test("pairs a daemon to one authenticated owner and hides it from other users", async () => {
  const t = convexTest(schema, modules);
  const owner = await createAuthenticatedUser(t);
  const otherUser = await createAuthenticatedUser(t);

  await expect(t.query(api.machines.listMachinesAndProjects, {})).rejects.toThrow("Not authenticated");
  const deviceToken = "a".repeat(32);
  const deviceNonce = "n".repeat(16);
  await t.mutation(api.pairing.start, { code: "pairing-code", deviceNonce, deviceToken });
  await owner.mutation(api.pairing.claim, { code: "pairing-code" });
  await expect(t.query(api.pairing.waitForClaim, { code: "pairing-code" })).resolves.toMatchObject({ nonce: deviceNonce, status: "claimed" });

  await t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceNonce,
    deviceToken,
    name: "owner-machine",
    platform: "linux",
    projects: [{ name: "relay", path: "/repo/relay" }],
  });
  await t.mutation(api.machines.setCapabilityCeiling, { capabilities: ["read", "edit"], deviceToken });

  await expect(owner.query(api.machines.listMachinesAndProjects, {})).resolves.toMatchObject([{ capabilityCeiling: ["read", "edit"], name: "owner-machine" }]);
  await expect(otherUser.query(api.machines.listMachinesAndProjects, {})).resolves.toEqual([]);
});

test("revocation invalidates a daemon token on its next heartbeat", async () => {
  const t = convexTest(schema, modules);
  const owner = await createAuthenticatedUser(t);
  const deviceToken = "b".repeat(32);
  const deviceNonce = "r".repeat(16);
  await t.mutation(api.pairing.start, { code: "revoke-code", deviceNonce, deviceToken });
  await owner.mutation(api.pairing.claim, { code: "revoke-code" });
  const machineId = await t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceNonce,
    deviceToken,
    name: "revocable-machine",
    platform: "linux",
    projects: [],
  });

  await owner.mutation(api.machines.revoke, { machineId });
  await expect(t.mutation(api.machines.heartbeat, { deviceToken })).rejects.toThrow("revoked");
});

test("heartbeat stores canary telemetry separately from the high-churn machine record", async () => {
  const t = convexTest(schema, modules);
  const owner = await createAuthenticatedUser(t);
  const otherUser = await createAuthenticatedUser(t);
  const deviceToken = "t".repeat(32);
  const deviceNonce = "n".repeat(16);
  await t.mutation(api.pairing.start, { code: "telemetry-code", deviceNonce, deviceToken });
  await owner.mutation(api.pairing.claim, { code: "telemetry-code" });
  const machineId = await t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceNonce,
    deviceToken,
    name: "telemetry-machine",
    platform: "linux",
    projects: [],
  });

  await t.mutation(api.machines.heartbeat, {
    deviceToken,
    telemetry: {
      activeLeases: 1,
      authFailures: 0,
      crossOwnerResults: 0,
      duplicateCommands: 0,
      fallbackActivations: 2,
      mode: "kernel",
      pendingEffects: 0,
      projectionBacklog: 0,
      projectionDivergences: 0,
      projectionGaps: 0,
      recoverableFailures: 0,
      sandboxViolations: 0,
      unrecoverableFailures: 0,
    },
  });

  await expect(owner.query(api.machines.getTelemetry, { machineId })).resolves.toMatchObject({
    fallbackActivations: 2,
    machineId,
    mode: "kernel",
  });
  await expect(otherUser.query(api.machines.getTelemetry, { machineId })).rejects.toThrow("does not belong");
});

test("registers a claimed daemon after its pairing code expires", async () => {
  const t = convexTest(schema, modules);
  const ownerId = await t.run((ctx) => ctx.db.insert("users", {}));
  const deviceToken = "c".repeat(32);
  const deviceNonce = "d".repeat(16);

  await t.run(async (ctx) => {
    await ctx.db.insert("pairings", {
      codeHash: await digestSecret("expired-code"),
      deviceNonce,
      deviceTokenHash: await digestSecret(deviceToken),
      expiresAt: Date.now() - 1,
      ownerId,
      status: "claimed",
    });
  });

  await expect(t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceNonce,
    deviceToken,
    name: "delayed-machine",
    platform: "linux",
    projects: [],
  })).resolves.toBeDefined();
});

test("legacy claimed pairings without a nonce cannot register a new machine", async () => {
  const t = convexTest(schema, modules);
  const ownerId = await t.run((ctx) => ctx.db.insert("users", {}));
  const deviceToken = "l".repeat(32);
  const code = "legacy-no-nonce";

  await t.run(async (ctx) => {
    await ctx.db.insert("pairings", {
      codeHash: await digestSecret(code),
      deviceTokenHash: await digestSecret(deviceToken),
      expiresAt: Date.now() + 60_000,
      ownerId,
      status: "claimed",
    });
  });

  await expect(t.query(api.pairing.waitForClaim, { code })).resolves.toEqual({ nonce: "", status: "expired" });
  await expect(t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceNonce: "n".repeat(16),
    deviceToken,
    name: "legacy-machine",
    platform: "linux",
    projects: [],
  })).rejects.toThrow("Device nonce mismatch");
  await expect(t.mutation(internal.migrations.cleanupLegacyPairings, { limit: 100 })).resolves.toMatchObject({ deleted: 1 });
});

test("rejects registration with wrong device nonce", async () => {
  const t = convexTest(schema, modules);
  const owner = await createAuthenticatedUser(t);
  const deviceToken = "e".repeat(32);
  const deviceNonce = "n".repeat(16);
  await t.mutation(api.pairing.start, { code: "wrong-nonce-code", deviceNonce, deviceToken });
  await owner.mutation(api.pairing.claim, { code: "wrong-nonce-code" });

  await expect(t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceNonce: "x".repeat(16),
    deviceToken,
    name: "wrong-machine",
    platform: "linux",
    projects: [],
  })).rejects.toThrow("Device nonce mismatch");
});

test("rejects pairing start collision on active code", async () => {
  const t = convexTest(schema, modules);
  const deviceNonce = "n".repeat(16);
  const deviceToken = "a".repeat(32);
  await t.mutation(api.pairing.start, { code: "collide-code", deviceNonce, deviceToken });

  await expect(t.mutation(api.pairing.start, { code: "collide-code", deviceNonce: "y".repeat(16), deviceToken: "b".repeat(32) })).rejects.toThrow("already active");
});

test("rejects cross-owner machine listing", async () => {
  const t = convexTest(schema, modules);
  const owner = await createAuthenticatedUser(t);
  const otherUser = await createAuthenticatedUser(t);
  const deviceToken = "f".repeat(32);
  const deviceNonce = "n".repeat(16);

  await t.mutation(api.pairing.start, { code: "cross-owner", deviceNonce, deviceToken });
  await owner.mutation(api.pairing.claim, { code: "cross-owner" });
  await t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceNonce,
    deviceToken,
    name: "owner-machine",
    platform: "linux",
    projects: [],
  });

  // Other user should not see this machine
  await expect(otherUser.query(api.machines.listMachinesAndProjects, {})).resolves.toEqual([]);
  // Owner should see it
  const machines = await owner.query(api.machines.listMachinesAndProjects, {});
  expect(machines.length).toBeGreaterThan(0);
});

test("rejects stale device token on heartbeat", async () => {
  const t = convexTest(schema, modules);
  const owner = await createAuthenticatedUser(t);
  const deviceToken = "g".repeat(32);
  const deviceNonce = "n".repeat(16);

  await t.mutation(api.pairing.start, { code: "stale-token", deviceNonce, deviceToken });
  await owner.mutation(api.pairing.claim, { code: "stale-token" });
  await t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceNonce,
    deviceToken,
    name: "stale-machine",
    platform: "linux",
    projects: [],
  });

  // Unregistered token should be rejected
  await expect(t.mutation(api.machines.heartbeat, { deviceToken: "z".repeat(32) })).rejects.toThrow("Unknown device token");
});
