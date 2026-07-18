import { v } from "convex/values";
import { mutationGeneric, queryGeneric } from "convex/server";
import type { Id } from "../_generated/dataModel";
import { requireActiveMachine, requireOwnedThread, requireUser } from "../auth_helpers";

// ---------------------------------------------------------------------------
// Command inbox — authenticated remote-command ingress.
// Replaces per-work-type polling with a single command channel.
// ---------------------------------------------------------------------------

const SUPPORTED_COMMAND_KINDS = new Set([
  "turn.send",
  "turn.steer",
  "turn.stop",
  "run.create",
  "approval.resolve",
  "checkpoint.restore",
  "checkpoint.compare",
  "subagent.run",
  "git.stage",
  "git.commit",
  "git.push",
]);

export const submitToInbox = mutationGeneric({
  args: {
    commandId: v.string(),
    correlationId: v.string(),
    kind: v.string(),
    payloadJson: v.string(),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    if (!SUPPORTED_COMMAND_KINDS.has(args.kind)) throw new Error(`Unsupported command kind: ${args.kind}`);
    const userId = await requireUser(ctx);
    const thread = await requireOwnedThread(ctx, userId, args.threadId);
    const project = await ctx.db.get(thread.projectId);
    if (!project) throw new Error("Project not found");

    // Reject duplicate commandIds
    const existing = await ctx.db.query("commandInbox").withIndex("by_command_id", (q) => q.eq("commandId", args.commandId)).first();
    if (existing) return existing._id;

    return ctx.db.insert("commandInbox", {
      commandId: args.commandId,
      completedAt: undefined,
      correlationId: args.correlationId,
      createdAt: Date.now(),
      kind: args.kind,
      machineId: project.machineId,
      ownerId: userId,
      payloadJson: args.payloadJson,
      runId: args.threadId,
      status: "pending",
    });
  },
});

export const claimBatch = mutationGeneric({
  args: {
    deviceToken: v.string(),
    leaseDurationMs: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    const now = Date.now();
    const leaseExpiresAt = now + args.leaseDurationMs;
    const results: Array<{
      _id: string;
      commandId?: string;
      correlationId: string;
      kind: string;
      payloadJson: string;
      runId?: string;
    }> = [];

    // Claim pending commands for this machine
    const pending = await ctx.db.query("commandInbox").withIndex("by_machine", (q) => q.eq("machineId", machine._id)).filter((q) => q.eq(q.field("status"), "pending")).take(args.limit);

    for (const cmd of pending) {
      await ctx.db.patch(cmd._id, { leaseExpiresAt, leaseOwner: machine._id, leaseGeneration: (cmd.leaseGeneration ?? 0) + 1, status: "claimed" });
      results.push({ _id: cmd._id, commandId: cmd.commandId, correlationId: cmd.correlationId, kind: cmd.kind, payloadJson: cmd.payloadJson, runId: cmd.runId });
    }

    // Reclaim expired claimed commands for this machine
    if (results.length < args.limit) {
      const expired = await ctx.db
        .query("commandInbox")
        .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
        .filter((q) => q.and(q.eq(q.field("status"), "claimed"), q.lt(q.field("leaseExpiresAt"), now)))
        .take(args.limit - results.length);

      for (const cmd of expired) {
        await ctx.db.patch(cmd._id, { leaseExpiresAt, leaseGeneration: (cmd.leaseGeneration ?? 0) + 1, status: "claimed" });
        results.push({ _id: cmd._id, commandId: cmd.commandId, correlationId: cmd.correlationId, kind: cmd.kind, payloadJson: cmd.payloadJson, runId: cmd.runId });
      }
    }

    return results;
  },
});

export const completeInbox = mutationGeneric({
  args: {
    commandId: v.id("commandInbox"),
    deviceToken: v.string(),
    leaseGeneration: v.number(),
    status: v.union(v.literal("completed"), v.literal("rejected")),
  },
  handler: async (ctx, args) => {
    const cmd = await ctx.db.get(args.commandId);
    if (!cmd) throw new Error("Command not found");
    if (cmd.status === "completed" || cmd.status === "rejected") throw new Error("Command already terminal");

    const machine = await requireActiveMachine(ctx, args.deviceToken);
    if (cmd.machineId !== machine._id) throw new Error("Machine does not own this command");
    if (cmd.leaseOwner !== machine._id) throw new Error("Machine does not hold the active lease");
    if (cmd.leaseGeneration !== args.leaseGeneration) throw new Error("Stale lease generation — command was reclaimed");

    await ctx.db.patch(args.commandId, { completedAt: Date.now(), status: args.status });
  },
});
