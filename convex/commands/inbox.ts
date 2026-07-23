import { v } from "convex/values";
import { mutationGeneric, queryGeneric } from "convex/server";
import type { Id } from "../_generated/dataModel";
import { requireActiveMachine, requireOwnedThread, requireUser } from "../auth_helpers";

// ---------------------------------------------------------------------------
// Command inbox — authenticated remote-command ingress.
// Replaces per-work-type polling with a single command channel.
// ---------------------------------------------------------------------------

// Canonical command kinds must match the contracts in `@relay/contracts/src/commands.ts`
// and the daemon kernel dispatch in `apps/daemon/src/kernel-daemon.ts`.
// Unsupported kinds fail at ingress with a clear rejection message.
const SUPPORTED_COMMAND_KINDS = new Set([
  "run.create",
  "run.configure",
  "run.resume",
  "run.stop",
  "turn.send",
  "git.action",
  "turn.steer",
  "turn.interrupt",
  "approval.resolve",
  "review.comment.create",
  "checkpoint.restore",
  "checkpoint.compare",
  "subagent.run",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertAuthorizedProjectPath(payloadJson: string, authorizedPath: string): void {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return;
  }
  if (!isRecord(payload)) return;
  const projectPath = payload.projectPath;
  if (projectPath === undefined) return;
  if (typeof projectPath !== "string") throw new Error("projectPath must be a string");
  if (projectPath !== authorizedPath) throw new Error("projectPath must match the authorized project");
}

export const submitToInbox = mutationGeneric({
  args: {
    commandId: v.string(),
    correlationId: v.string(),
    kind: v.string(),
    payloadJson: v.string(),
    runId: v.optional(v.string()),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    if (!SUPPORTED_COMMAND_KINDS.has(args.kind)) throw new Error(`Unsupported command kind: ${args.kind}`);
    const canonicalRunId = args.runId ?? args.threadId;
    const userId = await requireUser(ctx);
    const thread = await requireOwnedThread(ctx, userId, args.threadId);
    const project = await ctx.db.get(thread.projectId);
    if (!project) throw new Error("Project not found");
    assertAuthorizedProjectPath(args.payloadJson, project.path);

    // Cross-owner protection: the project's machine must belong to the authenticated user.
    const machine = await ctx.db.get(project.machineId);
    if (!machine || machine.ownerId !== userId) throw new Error("Cross-owner command rejected");

    // Reject duplicate commandIds with differing immutable fields.
    // Exact replay returns the original receipt; conflicted reuse is rejected.
    const existing = await ctx.db.query("commandInbox").withIndex("by_command_id", (q) => q.eq("commandId", args.commandId)).first();
    if (existing) {
      if (existing.kind !== args.kind || existing.runId !== canonicalRunId || existing.correlationId !== args.correlationId || existing.payloadJson !== args.payloadJson) {
        const mismatches = [
          existing.kind !== args.kind ? "kind" : null,
          existing.runId !== canonicalRunId ? "runId" : null,
          existing.correlationId !== args.correlationId ? "correlationId" : null,
          existing.payloadJson !== args.payloadJson ? "payloadJson" : null,
        ].filter((field): field is string => field !== null);
        throw new Error(`Conflicting commandId "${args.commandId}": mismatched ${mismatches.join(", ")}`);
      }
      return existing._id;
    }

    return ctx.db.insert("commandInbox", {
      commandId: args.commandId,
      completedAt: undefined,
      correlationId: args.correlationId,
      createdAt: Date.now(),
      kind: args.kind,
      machineId: project.machineId,
      ownerId: userId,
      payloadJson: args.payloadJson,
      projectPath: project.path,
      runId: canonicalRunId,
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
      projectPath?: string;
      runId?: string;
      leaseGeneration: number;
    }> = [];

    // Claim pending commands for this machine
    const pending = await ctx.db.query("commandInbox").withIndex("by_machine", (q) => q.eq("machineId", machine._id)).filter((q) => q.eq(q.field("status"), "pending")).take(args.limit);

    for (const cmd of pending) {
      const leaseGeneration = (cmd.leaseGeneration ?? 0) + 1;
      await ctx.db.patch(cmd._id, { leaseExpiresAt, leaseOwner: machine._id, leaseGeneration, status: "claimed" });
      results.push({ _id: cmd._id, commandId: cmd.commandId, correlationId: cmd.correlationId, kind: cmd.kind, payloadJson: cmd.payloadJson, projectPath: cmd.projectPath, runId: cmd.runId, leaseGeneration });
    }

    // Reclaim expired claimed commands for this machine
    if (results.length < args.limit) {
      const expired = await ctx.db
        .query("commandInbox")
        .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
        .filter((q) => q.and(q.eq(q.field("status"), "claimed"), q.lt(q.field("leaseExpiresAt"), now)))
        .take(args.limit - results.length);

      for (const cmd of expired) {
        const leaseGeneration = (cmd.leaseGeneration ?? 0) + 1;
        await ctx.db.patch(cmd._id, { leaseExpiresAt, leaseOwner: machine._id, leaseGeneration, status: "claimed" });
        results.push({ _id: cmd._id, commandId: cmd.commandId, correlationId: cmd.correlationId, kind: cmd.kind, payloadJson: cmd.payloadJson, projectPath: cmd.projectPath, runId: cmd.runId, leaseGeneration });
      }
    }

    return results;
  },
});

export const renewLease = mutationGeneric({
  args: {
    commandId: v.id("commandInbox"),
    deviceToken: v.string(),
    leaseDurationMs: v.number(),
    leaseGeneration: v.number(),
  },
  handler: async (ctx, args) => {
    const cmd = await ctx.db.get(args.commandId);
    if (!cmd) throw new Error("Command not found");
    if (cmd.status !== "claimed") throw new Error("Command is not claimed");

    const machine = await requireActiveMachine(ctx, args.deviceToken);
    if (cmd.machineId !== machine._id) throw new Error("Machine does not own this command");
    if (cmd.leaseOwner !== machine._id) throw new Error("Machine does not hold the active lease");
    if (cmd.leaseGeneration !== args.leaseGeneration) throw new Error("Stale lease generation — command was reclaimed");

    const newLeaseExpiresAt = Date.now() + args.leaseDurationMs;
    await ctx.db.patch(args.commandId, { leaseExpiresAt: newLeaseExpiresAt });
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
