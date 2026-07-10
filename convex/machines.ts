import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

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
    const existing = await ctx.db
      .query("machines")
      .withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken))
      .unique();
    const machineId = existing
      ? existing._id
      : await ctx.db.insert("machines", {
          daemonVersion: args.daemonVersion,
          deviceToken: args.deviceToken,
          lastHeartbeatAt: now,
          name: args.name,
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
      const existingProject = await ctx.db
        .query("projects")
        .withIndex("by_machine", (q) => q.eq("machineId", machineId))
        .filter((q) => q.eq(q.field("path"), project.path))
        .unique();

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
    const machine = await ctx.db
      .query("machines")
      .withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken))
      .unique();

    if (!machine) {
      throw new Error("Unknown development device token");
    }

    await ctx.db.patch(machine._id, { lastHeartbeatAt: Date.now() });
  },
});

export const listMachinesAndProjects = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const machines = await ctx.db.query("machines").collect();

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
