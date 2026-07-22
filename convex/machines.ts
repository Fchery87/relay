import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

import { digestSecret, requireOperator, requireUser } from "./auth_helpers";
import { toProjectSummary } from "./machine_summaries";

const platformValidator = v.union(v.literal("darwin"), v.literal("linux"), v.literal("win32"));
const projectValidator = v.object({ name: v.string(), path: v.string() });

export const registerMachine = mutationGeneric({
  args: {
    deviceNonce: v.optional(v.string()),
    deviceToken: v.string(),
    name: v.string(),
    platform: platformValidator,
    daemonVersion: v.string(),
    projects: v.array(projectValidator),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const deviceTokenHash = await digestSecret(args.deviceToken);
    const existing = await ctx.db
      .query("machines")
      .withIndex("by_device_token_hash", (q) => q.eq("deviceTokenHash", deviceTokenHash))
      .unique();
    if (existing?.revokedAt) throw new Error("Device token has been revoked");
    const pairing = existing ? null : await ctx.db.query("pairings").withIndex("by_device_token_hash", (q) => q.eq("deviceTokenHash", deviceTokenHash)).unique();
    if (!existing && (!pairing || pairing.status !== "claimed" || !pairing.ownerId)) throw new Error("Device token has not been paired");
    // Validate the device nonce matches — prevents an attacker from registering
    // a different machine against a pairing they claimed but didn't originate.
    if (pairing && !existing && args.deviceNonce && args.deviceNonce !== pairing.deviceNonce) {
      throw new Error("Device nonce mismatch — pairing was not started by this device");
    }
    const machineId = existing
      ? existing._id
      : await ctx.db.insert("machines", {
          daemonVersion: args.daemonVersion,
          deviceTokenHash,
          lastHeartbeatAt: now,
          name: args.name,
          ownerId: pairing!.ownerId,
          platform: args.platform,
        });

    if (existing) {
      // Detect topology drift: daemon version change is recorded for supervision.
      const versionChanged = existing.daemonVersion !== args.daemonVersion;
      const platformChanged = existing.platform !== args.platform;
      await ctx.db.patch(machineId, {
        daemonVersion: args.daemonVersion,
        lastHeartbeatAt: now,
        name: args.name,
        platform: args.platform,
      });
      if (versionChanged || platformChanged) {
        console.warn(`Topology drift for machine ${args.name}: version=${existing.daemonVersion}→${args.daemonVersion} platform=${existing.platform}→${args.platform}`);
      }
    }

    const registeredPaths = new Set(args.projects.map((project) => project.path));
    const existingProjects = await ctx.db
      .query("projects")
      .withIndex("by_machine", (q) => q.eq("machineId", machineId))
      .collect();

    for (const project of existingProjects) {
      if (!registeredPaths.has(project.path)) {
        await ctx.db.patch(project._id, { archivedAt: now });
      }
    }

    for (const project of args.projects) {
      const existingProject = existingProjects.find((existing) => existing.path === project.path);

      if (existingProject) {
        await ctx.db.patch(existingProject._id, { archivedAt: undefined, name: project.name, status: "active" as const });
      } else {
        await ctx.db.insert("projects", { ...project, machineId, status: "active" as const });
      }
    }

    return machineId;
  },
});

export const heartbeat = mutationGeneric({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const deviceTokenHash = await digestSecret(args.deviceToken);
    const machine = await ctx.db
      .query("machines")
      .withIndex("by_device_token_hash", (q) => q.eq("deviceTokenHash", deviceTokenHash))
      .unique();

    if (!machine) {
      throw new Error("Unknown device token");
    }
    if (machine.revokedAt) throw new Error("Device token has been revoked");

    await ctx.db.patch(machine._id, { lastHeartbeatAt: Date.now() });
  },
});

export const setCapabilityCeiling = mutationGeneric({
  args: { capabilities: v.array(v.union(v.literal("read"), v.literal("edit"), v.literal("exec"), v.literal("task"))), deviceToken: v.string() },
  handler: async (ctx, args) => {
    const deviceTokenHash = await digestSecret(args.deviceToken);
    const machine = await ctx.db.query("machines").withIndex("by_device_token_hash", (q) => q.eq("deviceTokenHash", deviceTokenHash)).unique();
    if (!machine || machine.revokedAt) throw new Error("Unknown or revoked device token");
    await ctx.db.patch(machine._id, { capabilityCeiling: [...new Set(args.capabilities)] });
  },
});

export const listMachinesAndProjects = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const machines = await ctx.db.query("machines").withIndex("by_owner", (q) => q.eq("ownerId", userId)).collect();

    return Promise.all(
      machines.map(async (machine) => ({
        capabilityCeiling: machine.capabilityCeiling,
        daemonVersion: machine.daemonVersion,
        id: machine._id,
        lastHeartbeatAt: machine.lastHeartbeatAt,
        name: machine.name,
        platform: machine.platform,
        projects: (await ctx.db
          .query("projects")
          .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
          .collect()).map(toProjectSummary),
      })),
    );
  },
});

export const revoke = mutationGeneric({
  args: { machineId: v.id("machines") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const machine = await ctx.db.get(args.machineId);
    if (!machine || machine.ownerId !== userId) throw new Error("Machine does not belong to the current user");
    await ctx.db.patch(machine._id, { revokedAt: Date.now() });
  },
});

/** Topology health check — reports online machines, stale heartbeats, and version skew. */
/** Export a backup manifest of all machine-local and remote state for restore verification. */
export const backupManifest = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const machines = await ctx.db.query("machines").withIndex("by_owner", (q) => q.eq("ownerId", userId)).collect();
    const now = Date.now();
    const manifest = {
      exportedAt: now,
      userId,
      machines: await Promise.all(machines.map(async (m) => ({
        id: m._id,
        name: m.name,
        platform: m.platform,
        daemonVersion: m.daemonVersion,
        lastHeartbeatAt: m.lastHeartbeatAt,
        revokedAt: m.revokedAt,
        projectCount: (await ctx.db.query("projects").withIndex("by_machine", (q) => q.eq("machineId", m._id)).take(200)).length,
        projectionSnapshotCount: (await ctx.db.query("projectionSnapshots").withIndex("by_machine", (q) => q.eq("machineId", m._id)).take(200)).length,
      }))),
      totalProjects: (await ctx.db.query("projects").take(1000)).length,
      totalProjectionEvents: (await ctx.db.query("projectionEvents").take(1000)).length,
      totalProjectionSnapshots: (await ctx.db.query("projectionSnapshots").take(1000)).length,
    };
    return manifest;
  },
});

export const topologyHealth = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const machines = await ctx.db.query("machines").filter((q) => q.eq(q.field("revokedAt"), undefined)).take(200);
    const staleThreshold = 60_000; // 60 seconds without heartbeat
    const online = machines.filter((m) => now - m.lastHeartbeatAt < staleThreshold);
    const stale = machines.filter((m) => now - m.lastHeartbeatAt >= staleThreshold);
    const versions = new Map<string, number>();
    for (const m of online) {
      versions.set(m.daemonVersion, (versions.get(m.daemonVersion) ?? 0) + 1);
    }
    return {
      healthy: stale.length === 0,
      onlineCount: online.length,
      staleCount: stale.length,
      staleMachines: stale.map((m) => ({ name: m.name, lastHeartbeatAt: m.lastHeartbeatAt, platform: m.platform })),
      versionSkew: versions.size > 1 ? Array.from(versions.entries()).map(([v, c]) => ({ version: v, count: c })) : null,
    };
  },
});
