import { v } from "convex/values";
import { makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { DEFAULT_MODEL_ID } from "@relay/shared";
import type { Id } from "../_generated/dataModel";
import { requireActiveMachine, requireOwnedProject, requireOwnedThread, requireUser } from "../auth_helpers";

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
  "plan.update",
  "plan.approve",
  "run.resume",
  "run.stop",
  "turn.send",
  "git.action",
  "turn.steer",
  "turn.interrupt",
  "approval.resolve",
  "mcp.elicitation.resolve",
  "mcp.elicitation.cancel",
  "review.comment.create",
  "checkpoint.restore",
  "checkpoint.compare",
  "subagent.run",
]);
const removeUsageForThread = makeFunctionReference<"mutation", { threadId: string }, null>("usage:removeForThreadBatch");

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

export const createRun = mutationGeneric({
  args: {
    commandId: v.string(),
    correlationId: v.string(),
    mode: v.optional(v.union(v.literal("chat"), v.literal("plan"))),
    projectId: v.id("projects"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const project = await requireOwnedProject(ctx, userId, args.projectId);
    const payloadJson = JSON.stringify({ ...(args.mode ? { mode: args.mode } : {}), projectId: args.projectId, title: args.title });
    const existing = await ctx.db.query("commandInbox").withIndex("by_command_id", (q) => q.eq("commandId", args.commandId)).first();
    if (existing) {
      if (existing.kind !== "run.create" || existing.correlationId !== args.correlationId || existing.payloadJson !== payloadJson) {
        throw new Error(`Conflicting commandId "${args.commandId}" for canonical run creation`);
      }
      if (!existing.threadId) throw new Error(`Canonical run creation command "${args.commandId}" has no thread identity`);
      return existing.threadId;
    }

    const threadId = await ctx.db.insert("threads", {
      ...(args.mode ? { mode: args.mode } : {}),
      permissionProfile: "workspace-write",
      projectId: args.projectId,
      ...(args.mode === "plan" ? { buildModelId: DEFAULT_MODEL_ID, planModelId: DEFAULT_MODEL_ID, planPhase: "planning" as const } : {}),
      modelId: DEFAULT_MODEL_ID,
      status: "idle",
      stopRequested: false,
      thinkingLevel: "none",
      title: args.title,
      usageTotals: { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, thinkingTokensUnavailableCalls: 0 },
    });
    await ctx.db.insert("commandInbox", {
      commandId: args.commandId,
      completedAt: undefined,
      correlationId: args.correlationId,
      createdAt: Date.now(),
      kind: "run.create",
      machineId: project.machineId,
      ownerId: userId,
      payloadJson,
      projectPath: project.path,
      runId: threadId,
      status: "pending",
      threadId,
    });
    await ctx.db.insert("auditLog", {
      action: "command.accepted",
      actorId: userId,
      actorKind: "user",
      causationId: args.commandId,
      category: "command",
      correlationId: args.correlationId,
      machineId: project.machineId,
      policyVersion: "command-ingress-v1",
      projectId: args.projectId,
      requestedScope: project.path,
      summary: `run.create accepted for ${threadId}`,
      threadId,
      effectiveScope: project.path,
    });
    return threadId;
  },
});

/** Delete a run through the canonical browser boundary during projection cutover. */
export const deleteRun = mutationGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const thread = await requireOwnedThread(ctx, userId, args.threadId);
    const project = await ctx.db.get(thread.projectId);
    if (!project) throw new Error("Project not found");

    const commands = await ctx.db.query("commandInbox").withIndex("by_machine", (q) => q.eq("machineId", project.machineId)).filter((q) => q.eq(q.field("threadId"), args.threadId)).collect();
    for (const command of commands) await ctx.db.delete(command._id);
    for await (const server of ctx.db.query("mcpServers").withIndex("by_approval_thread_id", (q) => q.eq("approvalThreadId", args.threadId))) await ctx.db.delete(server._id);
    for await (const elicitation of ctx.db.query("mcpElicitations").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(elicitation._id);
    for await (const plan of ctx.db.query("plans").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(plan._id);
    for await (const run of ctx.db.query("subagentRuns").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(run._id);
    for await (const event of ctx.db.query("events").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(event._id);
    for await (const comparison of ctx.db.query("checkpointComparisons").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(comparison._id);
    for await (const action of ctx.db.query("checkpointActions").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(action._id);
    for await (const checkpoint of ctx.db.query("checkpoints").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(checkpoint._id);
    for await (const message of ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(message._id);
    for await (const comment of ctx.db.query("diffComments").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(comment._id);
    for await (const approval of ctx.db.query("approvals").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(approval._id);
    for await (const audit of ctx.db.query("auditLog").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(audit._id);
    for await (const event of ctx.db.query("projectionEvents").withIndex("by_run_sequence", (q) => q.eq("runId", args.threadId))) {
      if (event.ownerId === userId && event.machineId === project.machineId) await ctx.db.delete(event._id);
    }
    for await (const snapshot of ctx.db.query("projectionSnapshots").withIndex("by_run", (q) => q.eq("runId", args.threadId))) {
      if (snapshot.ownerId === userId && snapshot.machineId === project.machineId) await ctx.db.delete(snapshot._id);
    }
    await ctx.db.insert("auditLog", {
      action: "run.deleted",
      actorId: userId,
      actorKind: "user",
      category: "command",
      correlationId: `delete:${args.threadId}`,
      machineId: project.machineId,
      policyVersion: "command-ingress-v1",
      projectId: project._id,
      requestedScope: project.path,
      effectiveScope: project.path,
      summary: `Deleted run ${args.threadId}`,
      threadId: args.threadId,
    });
    await ctx.scheduler.runAfter(0, removeUsageForThread, { threadId: args.threadId });
    await ctx.db.delete(args.threadId);
    return null;
  },
});

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

    const inboxId = await ctx.db.insert("commandInbox", {
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
      threadId: args.threadId,
    });
    await ctx.db.insert("auditLog", {
      action: "command.accepted",
      actorId: userId,
      actorKind: "user",
      causationId: args.commandId,
      category: "command",
      correlationId: args.correlationId,
      machineId: project.machineId,
      policyVersion: "command-ingress-v1",
      projectId: thread.projectId,
      requestedScope: project.path,
      summary: `${args.kind} accepted for ${canonicalRunId}`,
      threadId: args.threadId,
      effectiveScope: project.path,
    });
    return inboxId;
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
      const commandThread = cmd.threadId ? await ctx.db.get(cmd.threadId) : null;
      await ctx.db.insert("auditLog", {
        action: "command.claimed",
        actorId: machine._id,
        actorKind: "device",
        causationId: cmd.commandId,
        category: "command",
        correlationId: cmd.correlationId,
        machineId: machine._id,
        policyVersion: "command-ingress-v1",
        ...(commandThread ? { projectId: commandThread.projectId, threadId: commandThread._id } : {}),
        requestedScope: cmd.projectPath,
        effectiveScope: cmd.projectPath,
        summary: `${cmd.kind} claimed`,
      });
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
        const commandThread = cmd.threadId ? await ctx.db.get(cmd.threadId) : null;
        await ctx.db.insert("auditLog", {
          action: "command.reclaimed",
          actorId: machine._id,
          actorKind: "device",
          causationId: cmd.commandId,
          category: "command",
          correlationId: cmd.correlationId,
          machineId: machine._id,
          policyVersion: "command-ingress-v1",
          ...(commandThread ? { projectId: commandThread.projectId, threadId: commandThread._id } : {}),
          requestedScope: cmd.projectPath,
          effectiveScope: cmd.projectPath,
          summary: `${cmd.kind} reclaimed`,
        });
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
    const commandThread = cmd.threadId ? await ctx.db.get(cmd.threadId) : null;
    await ctx.db.insert("auditLog", {
      action: "command.lease.renewed",
      actorId: machine._id,
      actorKind: "device",
      causationId: cmd.commandId,
      category: "command",
      correlationId: cmd.correlationId,
      machineId: machine._id,
      policyVersion: "command-ingress-v1",
      ...(commandThread ? { projectId: commandThread.projectId, threadId: commandThread._id } : {}),
      requestedScope: cmd.projectPath,
      effectiveScope: cmd.projectPath,
      summary: `${cmd.kind} lease renewed`,
    });
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
    const commandThread = cmd.threadId ? await ctx.db.get(cmd.threadId) : null;
    await ctx.db.insert("auditLog", {
      action: `command.${args.status}`,
      actorId: machine._id,
      actorKind: "device",
      causationId: cmd.commandId,
      category: "command",
      correlationId: cmd.correlationId,
      machineId: machine._id,
      policyVersion: "command-ingress-v1",
      ...(commandThread ? { projectId: commandThread.projectId, threadId: commandThread._id } : {}),
      requestedScope: cmd.projectPath,
      effectiveScope: args.status === "completed" ? cmd.projectPath : "none",
      summary: `${cmd.kind} ${args.status}`,
    });
  },
});
