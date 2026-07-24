import { DEFAULT_SUBAGENT_ROLES, MODEL_CATALOG, listThinkingLevels, narrowCapabilities, type Capability } from "@relay/shared";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireActiveMachine, requireDeviceForThread, requireOwnedThread, requireUser } from "./auth_helpers";

const capability = v.union(v.literal("read"), v.literal("edit"), v.literal("exec"), v.literal("task"));
const result = v.object({
  artifacts: v.array(v.string()), findings: v.array(v.string()), status: v.union(v.literal("success"), v.literal("failed")), summary: v.string(),
});

export const seedDefaults = mutation({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    await requireActiveMachine(ctx, args.deviceToken);
    for (const role of DEFAULT_SUBAGENT_ROLES) {
      const existing = await ctx.db.query("roles").withIndex("by_name", (q) => q.eq("name", role.name)).unique();
      if (!existing) await ctx.db.insert("roles", { ...role, capabilities: [...role.capabilities] });
    }
  },
});

export const listRoles = query({ args: {}, handler: async (ctx) => { await requireUser(ctx); return ctx.db.query("roles").collect(); } });

export const updateRole = mutation({
  args: {
    capabilities: v.optional(v.array(capability)), contextMode: v.optional(v.union(v.literal("fresh"), v.literal("forked"))), description: v.optional(v.string()),
    maxTurns: v.optional(v.number()), modelId: v.optional(v.string()), prompt: v.optional(v.string()), roleId: v.id("roles"),
    thinkingLevel: v.optional(v.union(v.literal("none"), v.literal("low"), v.literal("medium"), v.literal("high"))), writer: v.optional(v.boolean()),
  },
  handler: async (ctx, { roleId, ...patch }) => {
    await requireUser(ctx);
    const role = await ctx.db.get("roles", roleId);
    if (!role) throw new Error("Role not found");
    if (patch.maxTurns !== undefined && (!Number.isInteger(patch.maxTurns) || patch.maxTurns < 1 || patch.maxTurns > 100)) throw new Error("maxTurns must be between 1 and 100");
    const model = MODEL_CATALOG.models.find((entry) => entry.id === (patch.modelId ?? role.modelId));
    if (!model) throw new Error("Model is not in the catalog");
    if (!listThinkingLevels(model).includes(patch.thinkingLevel ?? role.thinkingLevel)) throw new Error("Thinking level is not supported by this model");
    if (!(patch.writer ?? role.writer) && (patch.capabilities ?? role.capabilities).some((item) => item === "edit" || item === "exec")) throw new Error("Read-only roles cannot edit or execute");
    await ctx.db.patch(roleId, patch);
  },
});

export const enqueue = mutation({
  args: { capabilities: v.array(capability), depth: v.number(), deviceToken: v.string(), parentRunId: v.optional(v.id("subagentRuns")), roleId: v.id("roles"), task: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const machine = await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    const role = await ctx.db.get("roles", args.roleId);
    if (!role) throw new Error("Role not found");
    const parent = args.parentRunId ? await ctx.db.get("subagentRuns", args.parentRunId) : null;
    if (args.parentRunId && (!parent || parent.threadId !== args.threadId)) throw new Error("Parent subagent not found");
    const parentCapabilities = parent?.capabilities ?? machine.capabilityCeiling ?? [];
    const capabilities = narrowCapabilities({ child: args.capabilities as Capability[], depth: args.depth, parent: parentCapabilities as Capability[] });
    for (const granted of capabilities) if (!role.capabilities.includes(granted)) throw new Error(`Role capability ${granted} is not allowed`);
    return await ctx.db.insert("subagentRuns", { capabilities, depth: args.depth, machineId: machine._id, parentRunId: args.parentRunId, roleId: args.roleId, status: "queued", task: args.task, threadId: args.threadId });
  },
});

export const enqueueByName = mutation({
  args: { capabilities: v.array(capability), depth: v.number(), deviceToken: v.string(), parentRunId: v.optional(v.id("subagentRuns")), roleName: v.string(), task: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const machine = await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    const role = await ctx.db.query("roles").withIndex("by_name", (q) => q.eq("name", args.roleName)).unique();
    if (!role) throw new Error("Role not found");
    const parent = args.parentRunId ? await ctx.db.get("subagentRuns", args.parentRunId) : null;
    if (args.parentRunId && (!parent || parent.threadId !== args.threadId)) throw new Error("Parent subagent not found");
    const parentCapabilities = parent?.capabilities ?? machine.capabilityCeiling ?? [];
    const capabilities = narrowCapabilities({ child: args.capabilities as Capability[], depth: args.depth, parent: parentCapabilities as Capability[] });
    for (const granted of capabilities) if (!role.capabilities.includes(granted)) throw new Error(`Role capability ${granted} is not allowed`);
    return await ctx.db.insert("subagentRuns", { capabilities, depth: args.depth, machineId: machine._id, parentRunId: args.parentRunId, roleId: role._id, status: "queued", task: args.task, threadId: args.threadId });
  },
});

export const claim = mutation({
  args: { depth: v.optional(v.number()), deviceToken: v.string() },
  handler: async (ctx, args) => {
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    const now = Date.now();
    const depth = args.depth;
    // Scope the claim to this daemon, status, and worker depth. The daemon
    // has separate top-level and nested pollers, so scanning the other
    // poller's queued/running runs makes empty claims exceed the 1s budget.
    const queued = depth === undefined
      ? await ctx.db.query("subagentRuns").withIndex("by_machine_and_status_and_depth", (q) => q.eq("machineId", machine._id).eq("status", "queued")).take(50)
      : await ctx.db.query("subagentRuns").withIndex("by_machine_and_status_and_depth", (q) => q.eq("machineId", machine._id).eq("status", "queued").eq("depth", depth)).take(50);
    const running = depth === undefined
      ? await ctx.db.query("subagentRuns").withIndex("by_machine_and_status_and_depth", (q) => q.eq("machineId", machine._id).eq("status", "running")).take(50)
      : await ctx.db.query("subagentRuns").withIndex("by_machine_and_status_and_depth", (q) => q.eq("machineId", machine._id).eq("status", "running").eq("depth", depth)).take(50);
    const candidates = [...queued, ...running];
    for (const run of candidates) {
      if (args.depth !== undefined && run.depth !== args.depth) continue;
      if (run.status === "running" && (run.leaseExpiresAt ?? Infinity) > now) continue;
      const thread = await ctx.db.get("threads", run.threadId);
      const project = thread ? await ctx.db.get("projects", thread.projectId) : null;
      if (!project || project.machineId !== machine._id) continue;
      const role = await ctx.db.get("roles", run.roleId);
      if (!role) continue;
      const claimToken = crypto.randomUUID();
      await ctx.db.patch(run._id, { claimToken, leaseExpiresAt: now + 30_000, status: "running" });
      return { capabilities: run.capabilities, claimToken, contextMode: role.contextMode, depth: run.depth, maxTurns: role.maxTurns, modelId: role.modelId, parentRunId: run.parentRunId, projectPath: project.path, prompt: role.prompt, roleName: role.name, runId: run._id, task: run.task, thinkingLevel: role.thinkingLevel, threadId: run.threadId, writer: role.writer };
    }
    return null;
  },
});

export const complete = mutation({
  args: { claimToken: v.string(), deviceToken: v.string(), result, runId: v.id("subagentRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get("subagentRuns", args.runId);
    if (!run) throw new Error("Subagent run not found");
    await requireDeviceForThread(ctx, args.deviceToken, run.threadId);
    if (run.status !== "running" || run.claimToken !== args.claimToken) throw new Error("Subagent lease is stale");
    await ctx.db.patch(run._id, { result: args.result, status: args.result.status === "success" ? "complete" : "failed" });
  },
});

export const listTree = query({ args: { threadId: v.id("threads") }, handler: async (ctx, args) => { await requireOwnedThread(ctx, await requireUser(ctx), args.threadId); return ctx.db.query("subagentRuns").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).take(100); } });

export const getResult = query({
  args: { deviceToken: v.string(), runId: v.id("subagentRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get("subagentRuns", args.runId);
    if (!run) throw new Error("Subagent run not found");
    await requireDeviceForThread(ctx, args.deviceToken, run.threadId);
    return { result: run.result, status: run.status, threadId: run.threadId };
  },
});

export const renewLease = mutation({
  args: { claimToken: v.string(), deviceToken: v.string(), runId: v.id("subagentRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get("subagentRuns", args.runId);
    if (!run) throw new Error("Subagent run not found");
    await requireDeviceForThread(ctx, args.deviceToken, run.threadId);
    if (run.status !== "running" || run.claimToken !== args.claimToken) throw new Error("Subagent lease is stale");
    await ctx.db.patch(run._id, { leaseExpiresAt: Date.now() + 30_000 });
  },
});
