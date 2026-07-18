import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

import { requireActiveMachine, requireUser } from "./auth_helpers";

export const publishCatalog = mutationGeneric({
  args: {
    commands: v.array(v.object({
      argumentHint: v.optional(v.string()),
      description: v.string(),
      name: v.string(),
      projectId: v.optional(v.id("projects")),
      scope: v.union(v.literal("builtin"), v.literal("project"), v.literal("user"), v.literal("skill")),
    })),
    deviceToken: v.string(),
  },
  handler: async (ctx, args) => {
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    // Delete all existing commands for this machine
    const existing = await ctx.db.query("slashCommands").withIndex("by_machine", (q) => q.eq("machineId", machine._id)).collect();
    for (const cmd of existing) await ctx.db.delete(cmd._id);
    // Insert new catalog
    for (const cmd of args.commands) {
      await ctx.db.insert("slashCommands", { ...cmd, machineId: machine._id });
    }
  },
});

export const listForThread = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) return [];
    const project = await ctx.db.get(thread.projectId);
    if (!project) return [];
    const machine = await ctx.db.get(project.machineId);
    if (!machine || machine.ownerId !== userId) return [];

    const commands = await ctx.db.query("slashCommands").withIndex("by_machine", (q) => q.eq("machineId", machine._id)).collect();

    // Sort: builtin → project → user → skill
    const order: Record<string, number> = { builtin: 0, project: 1, user: 2, skill: 3 };
    commands.sort((a, b) => (order[a.scope] ?? 99) - (order[b.scope] ?? 99));

    return commands.filter((cmd) => {
      // Project-scoped commands only visible when project matches
      if (cmd.scope === "project" && cmd.projectId !== project._id) return false;
      return true;
    }).map(({ _id, machineId, ...rest }) => rest);
  },
});
