import { v } from "convex/values";
import { mutationGeneric, queryGeneric } from "convex/server";
import type { Id } from "../_generated/dataModel";
import { requireActiveMachine } from "../auth_helpers";

// ---------------------------------------------------------------------------
// Command inbox — authenticated remote-command ingress.
// Replaces per-work-type polling with a single command channel.
// ---------------------------------------------------------------------------

export const submitToInbox = mutationGeneric({
  args: {
    correlationId: v.string(),
    kind: v.string(),
    machineId: v.string(),
    ownerId: v.optional(v.id("users")),
    payloadJson: v.string(),
    runId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("commandInbox", {
      completedAt: undefined,
      correlationId: args.correlationId,
      createdAt: Date.now(),
      kind: args.kind,
      machineId: ctx.db.normalizeId("machines", args.machineId as Id<"machines">),
      ownerId: args.ownerId,
      payloadJson: args.payloadJson,
      runId: args.runId,
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

    // Claim unclaimed or expired-lease commands for this machine
    const pending = await ctx.db
      .query("commandInbox")
      .withIndex("by_status_lease", (q) => q.eq("status", "pending"))
      .take(args.limit);

    const results: Array<{
      _id: string;
      correlationId: string;
      kind: string;
      payloadJson: string;
      runId?: string;
    }> = [];

    const leaseExpiresAt = now + args.leaseDurationMs;
    for (const cmd of pending) {
      // Only claim commands for this machine
      if (cmd.machineId && cmd.machineId !== machine._id) continue;
      // Skip if still leased
      if (cmd.leaseExpiresAt && cmd.leaseExpiresAt > now) continue;

      await ctx.db.patch(cmd._id, {
        leaseExpiresAt,
        leaseOwner: machine._id,
        status: "claimed",
      });

      results.push({
        _id: cmd._id,
        correlationId: cmd.correlationId,
        kind: cmd.kind,
        payloadJson: cmd.payloadJson,
        runId: cmd.runId,
      });
    }

    return results;
  },
});

export const completeInbox = mutationGeneric({
  args: {
    commandId: v.id("commandInbox"),
    deviceToken: v.string(),
    status: v.union(v.literal("completed"), v.literal("rejected")),
  },
  handler: async (ctx, args) => {
    const cmd = await ctx.db.get(args.commandId);
    if (!cmd) throw new Error("Command not found");

    await requireActiveMachine(ctx, args.deviceToken);
    await ctx.db.patch(args.commandId, {
      completedAt: Date.now(),
      status: args.status,
    });
  },
});
