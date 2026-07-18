import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

import { requireActiveMachine, requireUser } from "./auth_helpers";

export const requestAdd = mutationGeneric({
  args: {
    machineId: v.id("machines"),
    name: v.string(),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const machine = await ctx.db.get(args.machineId);
    if (!machine || machine.ownerId !== userId) throw new Error("Machine does not belong to the current user");
    const existing = await ctx.db.query("projects").withIndex("by_machine", (q) => q.eq("machineId", args.machineId)).filter((q) => q.eq(q.field("path"), args.path)).unique();
    if (existing) throw new Error("A project with this path is already registered on this machine");
    return ctx.db.insert("projects", {
      machineId: args.machineId,
      name: args.name,
      path: args.path,
      status: "pending",
    });
  },
});

export const listPending = queryGeneric({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    const projects = await ctx.db.query("projects").withIndex("by_machine", (q) => q.eq("machineId", machine._id)).collect();
    return projects.filter((p) => p.status === "pending").map(({ _id, name, path }) => ({ id: _id, name, path }));
  },
});

export const resolvePending = mutationGeneric({
  args: {
    deviceToken: v.string(),
    projectId: v.id("projects"),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.machineId !== machine._id) throw new Error("Project not found on this machine");
    if (project.status !== "pending") throw new Error("Project is not pending");
    if (args.ok) {
      await ctx.db.patch(args.projectId, { error: undefined, status: "active" });
    } else {
      await ctx.db.patch(args.projectId, { error: args.error ?? "Unknown error", status: "error" });
    }
  },
});

export const requestTrust = mutationGeneric({
  args: {
    deviceToken: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.machineId !== machine._id) throw new Error("Project not found on this machine");
    // If already decided, no-op
    if (project.trustState === "trusted" || project.trustState === "untrusted") return;
    await ctx.db.patch(args.projectId, { trustRequestedAt: Date.now(), trustState: "requested" });
  },
});

export const resolveTrust = mutationGeneric({
  args: {
    projectId: v.id("projects"),
    trustState: v.union(v.literal("trusted"), v.literal("untrusted")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");
    const machine = await ctx.db.get(project.machineId);
    if (!machine || machine.ownerId !== userId) throw new Error("Machine does not belong to the current user");
    await ctx.db.patch(args.projectId, { trustRequestedAt: undefined, trustState: args.trustState });
  },
});

export const get = queryGeneric({
  args: {
    deviceToken: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.machineId !== machine._id) return null;
    return { trustState: project.trustState };
  },
});
