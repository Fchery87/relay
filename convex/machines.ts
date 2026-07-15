import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

import { digestSecret, requireUser } from "./auth_helpers";
import { toProjectSummary } from "./machine_summaries";

const platformValidator = v.union(v.literal("darwin"), v.literal("linux"), v.literal("win32"));
const projectValidator = v.object({ name: v.string(), path: v.string() });

export const registerMachine = mutationGeneric({
  args: {
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
      await ctx.db.patch(machineId, {
        daemonVersion: args.daemonVersion,
        lastHeartbeatAt: now,
        name: args.name,
        platform: args.platform,
      });
    }

    const registeredPaths = new Set(args.projects.map((project) => project.path));
    const existingProjects = await ctx.db
      .query("projects")
      .withIndex("by_machine", (q) => q.eq("machineId", machineId))
      .collect();

    for (const project of existingProjects) {
      if (!registeredPaths.has(project.path)) {
        await ctx.db.delete(project._id);
      }
    }

    for (const project of args.projects) {
      const existingProject = existingProjects.find((existing) => existing.path === project.path);

      if (existingProject) {
        await ctx.db.patch(existingProject._id, { name: project.name });
      } else {
        await ctx.db.insert("projects", { ...project, machineId });
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
