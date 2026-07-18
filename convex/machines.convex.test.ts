/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import { digestSecret } from "./auth_helpers";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

test("registerMachine archives unregistered projects instead of deleting them", async () => {
  const t = convexTest(schema, modules);
  const deviceToken = "d".repeat(32);
  const deviceTokenHash = await digestSecret(deviceToken);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  await t.run(async (ctx) => {
    await ctx.db.insert("machines", { daemonVersion: "test", deviceTokenHash, lastHeartbeatAt: Date.now(), name: "test", ownerId: userId, platform: "linux" });
  });

  // Register with projects A+B
  await t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceToken,
    name: "test",
    platform: "linux",
    projects: [{ name: "A", path: "/a" }, { name: "B", path: "/b" }],
  });

  // Re-register with only A — B should be archived
  await t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceToken,
    name: "test",
    platform: "linux",
    projects: [{ name: "A", path: "/a" }],
  });

  const projects = await t.run(async (ctx) => {
    const machines = await ctx.db.query("machines").withIndex("by_device_token_hash", (q) => q.eq("deviceTokenHash", deviceTokenHash)).collect();
    expect(machines).toHaveLength(1);
    return ctx.db.query("projects").withIndex("by_machine", (q) => q.eq("machineId", machines[0]!._id)).collect();
  });

  const projectA = projects.find((p) => p.path === "/a");
  const projectB = projects.find((p) => p.path === "/b");
  expect(projectA).toBeDefined();
  expect(projectA!.archivedAt).toBeUndefined();
  expect(projectB).toBeDefined();
  expect(projectB!.archivedAt).toBeTypeOf("number");

  // Re-register with A+B again — B should be un-archived
  await t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceToken,
    name: "test",
    platform: "linux",
    projects: [{ name: "A", path: "/a" }, { name: "B", path: "/b" }],
  });

  const projects2 = await t.run(async (ctx) => {
    const machines = await ctx.db.query("machines").withIndex("by_device_token_hash", (q) => q.eq("deviceTokenHash", deviceTokenHash)).collect();
    return ctx.db.query("projects").withIndex("by_machine", (q) => q.eq("machineId", machines[0]!._id)).collect();
  });

  const bAfterReAdd = projects2.find((p) => p.path === "/b");
  expect(bAfterReAdd).toBeDefined();
  expect(bAfterReAdd!.archivedAt).toBeUndefined();
});
