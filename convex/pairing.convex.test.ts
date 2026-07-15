import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
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
  await t.mutation(api.pairing.start, { code: "pairing-code", deviceToken });
  await owner.mutation(api.pairing.claim, { code: "pairing-code" });
  await expect(t.query(api.pairing.waitForClaim, { code: "pairing-code" })).resolves.toEqual({ status: "claimed" });

  await t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceToken,
    name: "owner-machine",
    platform: "linux",
    projects: [{ name: "relay", path: "/repo/relay" }],
  });

  await expect(owner.query(api.machines.listMachinesAndProjects, {})).resolves.toMatchObject([{ name: "owner-machine" }]);
  await expect(otherUser.query(api.machines.listMachinesAndProjects, {})).resolves.toEqual([]);
});

test("revocation invalidates a daemon token on its next heartbeat", async () => {
  const t = convexTest(schema, modules);
  const owner = await createAuthenticatedUser(t);
  const deviceToken = "b".repeat(32);
  await t.mutation(api.pairing.start, { code: "revoke-code", deviceToken });
  await owner.mutation(api.pairing.claim, { code: "revoke-code" });
  const machineId = await t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceToken,
    name: "revocable-machine",
    platform: "linux",
    projects: [],
  });

  await owner.mutation(api.machines.revoke, { machineId });
  await expect(t.mutation(api.machines.heartbeat, { deviceToken })).rejects.toThrow("revoked");
});

test("registers a claimed daemon after its pairing code expires", async () => {
  const t = convexTest(schema, modules);
  const ownerId = await t.run((ctx) => ctx.db.insert("users", {}));
  const deviceToken = "c".repeat(32);

  await t.run(async (ctx) => {
    await ctx.db.insert("pairings", {
      codeHash: await digestSecret("expired-code"),
      deviceTokenHash: await digestSecret(deviceToken),
      expiresAt: Date.now() - 1,
      ownerId,
      status: "claimed",
    });
  });

  await expect(t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceToken,
    name: "delayed-machine",
    platform: "linux",
    projects: [],
  })).resolves.toBeDefined();
});
