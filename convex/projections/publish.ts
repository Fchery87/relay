import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireActiveMachine, requireUser } from "../auth_helpers";
import type { Id } from "../_generated/dataModel";

// ---------------------------------------------------------------------------
// Append projection events — accepts only next-sequence or exact duplicate.
// ---------------------------------------------------------------------------

export const appendEvents = mutation({
  args: {
    events: v.array(
      v.object({
        eventId: v.string(),
        payloadJson: v.string(),
        projectId: v.id("projects"),
        runId: v.string(),
        sequence: v.number(),
        type: v.string(),
        occurredAt: v.number(),
      }),
    ),
    deviceToken: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    if (!machine.ownerId) throw new Error("Machine is not owned by an authenticated user");
    const ownerId: Id<"users"> = machine.ownerId;

    if (args.events.length > 200) throw new Error("Projection batch exceeds 200 events");
    for (const ev of args.events) {
      const project = await ctx.db.get(ev.projectId);
      if (!project || project.machineId !== machine._id) throw new Error("Projection project does not belong to machine");
      if (ev.sequence < 1 || ev.sequence > 1_000_000 || ev.payloadJson.length > 1_000_000) throw new Error("Invalid bounded projection event");
      // Check for exact duplicate (idempotent)
      const existing = await ctx.db
        .query("projectionEvents")
        .withIndex("by_run_sequence", (q) => q.eq("runId", ev.runId).eq("sequence", ev.sequence))
        .first();

      if (existing) {
        if (existing.eventId !== ev.eventId || existing.payloadJson !== ev.payloadJson || existing.type !== ev.type || existing.occurredAt !== ev.occurredAt || existing.ownerId !== ownerId || existing.machineId !== machine._id || existing.projectId !== ev.projectId) {
          throw new Error(`Conflicting duplicate projection event for ${ev.runId}:${ev.sequence}`);
        }
        continue;
      }

      const previous = await ctx.db.query("projectionEvents").withIndex("by_run_sequence", (q) => q.eq("runId", ev.runId).eq("sequence", ev.sequence - 1)).first();
      if (ev.sequence > 1 && (!previous || previous.ownerId !== ownerId)) throw new Error(`Gap or ownership mismatch for ${ev.runId}:${ev.sequence}`);

      const priorById = await ctx.db.query("projectionEvents").withIndex("by_event_id", (q) => q.eq("eventId", ev.eventId)).first();
      if (priorById && (priorById.runId !== ev.runId || priorById.sequence !== ev.sequence)) throw new Error(`Event ID already belongs to another projection position: ${ev.eventId}`);

      await ctx.db.insert("projectionEvents", { eventId: ev.eventId, machineId: machine._id, occurredAt: ev.occurredAt, ownerId, payloadJson: ev.payloadJson, publishedAt: now, runId: ev.runId, sequence: ev.sequence, type: ev.type, projectId: ev.projectId });
    }
  },
});

// ---------------------------------------------------------------------------
// Upsert projection snapshot — advances only when all events through sequence exist.
// ---------------------------------------------------------------------------

export const upsertSnapshot = mutation({
  args: {
    projectId: v.id("projects"),
    runId: v.string(),
    sequence: v.number(),
    snapshotJson: v.string(),
    deviceToken: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.machineId !== machine._id) throw new Error("Projection project does not belong to machine");

    const existing = await ctx.db
      .query("projectionSnapshots")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .first();

    if (existing) {
      if (existing.machineId !== machine._id || existing.ownerId !== machine.ownerId || existing.projectId !== args.projectId) throw new Error("Projection ownership mismatch");
      if (args.sequence < existing.sequence) throw new Error(`Snapshot regression for ${args.runId}`);
      if (args.sequence === existing.sequence && args.snapshotJson !== existing.snapshotJson) throw new Error(`Conflicting snapshot at ${args.runId}:${args.sequence}`);
      if (args.sequence === existing.sequence) return;
      await ctx.db.patch(existing._id, { sequence: args.sequence, snapshotJson: args.snapshotJson, updatedAt: now });
    } else {
      if (args.sequence > 0) {
        const last = await ctx.db.query("projectionEvents").withIndex("by_run_sequence", (q) => q.eq("runId", args.runId).eq("sequence", args.sequence)).first();
        if (!last || last.ownerId !== machine.ownerId) throw new Error(`Snapshot sequence ${args.sequence} has not been published for ${args.runId}`);
      }
      await ctx.db.insert("projectionSnapshots", { machineId: machine._id, ownerId: machine.ownerId, runId: args.runId, sequence: args.sequence, snapshotJson: args.snapshotJson, updatedAt: now, projectId: args.projectId });
    }
  },
});

// ---------------------------------------------------------------------------
// Advance projection cursor.
// ---------------------------------------------------------------------------

export const advanceCursor = mutation({
  args: {
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    machineId: v.string(),
    sequence: v.number(),
    deviceToken: v.string(),
  },
  handler: async (ctx, args) => {
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    if (machine._id !== ctx.db.normalizeId("machines", args.machineId as Id<"machines">)) throw new Error("Projection cursor machine mismatch");
    const existing = await ctx.db
      .query("projectionCursors")
      .withIndex("by_machine_direction", (q) =>
        q.eq("machineId", args.machineId).eq("direction", args.direction),
      )
      .first();

    if (existing) {
      if (args.sequence < existing.sequence) throw new Error(`Cursor regression for ${args.machineId}:${args.direction}`);
      if (args.sequence === existing.sequence) return;
      await ctx.db.patch(existing._id, { sequence: args.sequence, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("projectionCursors", {
        direction: args.direction,
        machineId: args.machineId,
        sequence: args.sequence,
        updatedAt: Date.now(),
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Flush projection outbox — daemon acknowledges published events.
// Returns the sequence up to which all events are acknowledged.
// ---------------------------------------------------------------------------

export const flushOutbox = mutation({
  args: {
    deviceToken: v.string(),
    projectId: v.id("projects"),
    throughSequence: v.number(),
  },
  handler: async (ctx, args) => {
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.machineId !== machine._id) throw new Error("Project does not belong to machine");

    // Verify all events through sequence exist and belong to this machine.
    for (let seq = 1; seq <= args.throughSequence; seq++) {
      const ev = await ctx.db.query("projectionEvents").withIndex("by_run_sequence", (q) => q.eq("runId", project.path).eq("sequence", seq)).first();
      if (!ev || ev.machineId !== machine._id) throw new Error(`Projection gap at ${project.path}:${seq}`);
    }

    // Advance the outbound cursor to the acknowledged sequence.
    const existing = await ctx.db.query("projectionCursors").withIndex("by_machine_direction", (q) => q.eq("machineId", machine._id).eq("direction", "outbound")).first();
    if (existing) {
      if (args.throughSequence < existing.sequence) throw new Error(`Outbound cursor regression for ${machine._id}`);
      await ctx.db.patch(existing._id, { sequence: args.throughSequence, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("projectionCursors", { direction: "outbound", machineId: machine._id, sequence: args.throughSequence, updatedAt: Date.now() });
    }
  },
});

// ---------------------------------------------------------------------------
// Owner-scoped projection reads — browser data plane.
// ---------------------------------------------------------------------------

export const getRunSnapshot = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const snap = await ctx.db.query("projectionSnapshots").withIndex("by_run", (q) => q.eq("runId", args.runId)).first();
    if (!snap || snap.ownerId !== userId) return null;
    return snap;
  },
});

export const listRunEvents = query({
  args: { afterSequence: v.number(), limit: v.number(), runId: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200) throw new Error("Projection limit must be between 1 and 200");
    const page = await ctx.db
      .query("projectionEvents")
      .withIndex("by_run_sequence", (q) => q.eq("runId", args.runId).gt("sequence", args.afterSequence))
      .take(args.limit);
    for (const ev of page) { if (ev.ownerId !== userId) throw new Error("Access denied"); }
    return page;
  },
});

export const getProjectionCursor = query({
  args: { direction: v.union(v.literal("inbound"), v.literal("outbound")), machineId: v.id("machines") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const machine = await ctx.db.get(args.machineId);
    if (!machine || machine.ownerId !== userId) return null;
    return ctx.db.query("projectionCursors").withIndex("by_machine_direction", (q) => q.eq("machineId", args.machineId).eq("direction", args.direction)).first();
  },
});

/** List projection snapshots belonging to a project for the authenticated user. */
export const listProjectionRuns = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (!projectId) return [];
    const project = await ctx.db.get(projectId);
    if (!project) return [];
    const machine = await ctx.db.get(project.machineId);
    if (!machine || machine.ownerId !== userId) return [];
    const snaps = await ctx.db.query("projectionSnapshots").withIndex("by_project", (q) => q.eq("projectId", projectId)).take(200);
    return snaps
      .filter((s) => s.ownerId === userId && s.machineId === project.machineId)
      .map((s) => {
        let snapshot: {
          budgetUsd?: unknown;
          modelId?: unknown;
          mode?: unknown;
          permissionProfile?: unknown;
          status?: unknown;
          thinkingLevel?: unknown;
          title?: unknown;
        } = {};
        try { snapshot = JSON.parse(s.snapshotJson) as typeof snapshot; } catch { /* use bounded defaults */ }
        const modelId = typeof snapshot.modelId === "string" ? snapshot.modelId : undefined;
        const mode = snapshot.mode === "chat" || snapshot.mode === "plan" ? snapshot.mode : undefined;
        const thinkingLevel = snapshot.thinkingLevel === "none" || snapshot.thinkingLevel === "low" || snapshot.thinkingLevel === "medium" || snapshot.thinkingLevel === "high" ? snapshot.thinkingLevel : undefined;
        const permissionProfile = snapshot.permissionProfile === "read-only" || snapshot.permissionProfile === "workspace-write" || snapshot.permissionProfile === "full-access" ? snapshot.permissionProfile : undefined;
        const budgetUsd = snapshot.budgetUsd === null || (typeof snapshot.budgetUsd === "number" && Number.isFinite(snapshot.budgetUsd)) ? snapshot.budgetUsd : undefined;
        return {
          ...(budgetUsd === undefined ? {} : { budgetUsd }),
          ...(modelId === undefined ? {} : { modelId }),
          ...(mode === undefined ? {} : { mode }),
          ...(permissionProfile === undefined ? {} : { permissionProfile }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          runId: s.runId,
          sequence: s.sequence,
          status: typeof snapshot.status === "string" ? snapshot.status : "active",
          title: typeof snapshot.title === "string" ? snapshot.title : `Run ${s.runId.slice(-8)}`,
          projectId: args.projectId,
          updatedAt: s.updatedAt,
        };
      });
  },
});

/** Observable projection metrics — backlog, gaps, retries, cursor lag. */
export const projectionMetrics = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const machines = await ctx.db.query("machines").withIndex("by_owner", (q) => q.eq("ownerId", userId)).collect();
    const now = Date.now();

    let totalEvents = 0;
    let totalSnapshots = 0;
    let gapCount = 0;
    let oldestPendingAge = 0;

    for (const machine of machines) {
      const events = await ctx.db.query("projectionEvents").withIndex("by_machine_run", (q) => q.eq("machineId", machine._id)).take(1000);
      totalEvents += events.length;

      const snaps = await ctx.db.query("projectionSnapshots").withIndex("by_machine_run", (q) => q.eq("machineId", machine._id)).take(200);
      totalSnapshots += snaps.length;

      // Detect sequence gaps
      const byRun = new Map<string, number[]>();
      for (const ev of events) {
        const seqs = byRun.get(ev.runId) ?? [];
        seqs.push(ev.sequence);
        byRun.set(ev.runId, seqs);
      }
      for (const [, seqs] of byRun) {
        seqs.sort((a, b) => a - b);
        for (let i = 1; i < seqs.length; i++) {
          if (seqs[i]! !== seqs[i - 1]! + 1) gapCount++;
        }
      }

      // Oldest pending cursor age
      const cursor = await ctx.db.query("projectionCursors").withIndex("by_machine_direction", (q) => q.eq("machineId", machine._id).eq("direction", "outbound")).first();
      if (cursor) {
        const lastEvent = events.filter(e => e.sequence > cursor.sequence).sort((a, b) => b.sequence - a.sequence)[0];
        if (lastEvent) {
          const age = now - lastEvent._creationTime;
          if (age > oldestPendingAge) oldestPendingAge = age;
        }
      }
    }

    return {
      totalEvents,
      totalSnapshots,
      gapCount,
      oldestPendingAgeMs: oldestPendingAge,
      backlogEvents: totalEvents - totalSnapshots > 0 ? totalEvents - totalSnapshots : 0,
    };
  },
});
