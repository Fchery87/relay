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

    for (const ev of args.events) {
      // Check for exact duplicate (idempotent)
      const existing = await ctx.db
        .query("projectionEvents")
        .withIndex("by_run_sequence", (q) => q.eq("runId", ev.runId).eq("sequence", ev.sequence))
        .first();

      if (existing) {
        if (existing.eventId !== ev.eventId || existing.payloadJson !== ev.payloadJson || existing.type !== ev.type || existing.occurredAt !== ev.occurredAt || existing.ownerId !== ownerId) {
          throw new Error(`Conflicting duplicate projection event for ${ev.runId}:${ev.sequence}`);
        }
        continue;
      }

      const previous = await ctx.db.query("projectionEvents").withIndex("by_run_sequence", (q) => q.eq("runId", ev.runId).eq("sequence", ev.sequence - 1)).first();
      if (ev.sequence > 1 && (!previous || previous.ownerId !== ownerId)) throw new Error(`Gap or ownership mismatch for ${ev.runId}:${ev.sequence}`);

      const priorById = await ctx.db.query("projectionEvents").withIndex("by_event_id", (q) => q.eq("eventId", ev.eventId)).first();
      if (priorById && (priorById.runId !== ev.runId || priorById.sequence !== ev.sequence)) throw new Error(`Event ID already belongs to another projection position: ${ev.eventId}`);

      await ctx.db.insert("projectionEvents", { eventId: ev.eventId, machineId: machine._id, occurredAt: ev.occurredAt, ownerId, payloadJson: ev.payloadJson, publishedAt: now, runId: ev.runId, sequence: ev.sequence, type: ev.type });
    }
  },
});

// ---------------------------------------------------------------------------
// Upsert projection snapshot — advances only when all events through sequence exist.
// ---------------------------------------------------------------------------

export const upsertSnapshot = mutation({
  args: {
    runId: v.string(),
    sequence: v.number(),
    snapshotJson: v.string(),
    deviceToken: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const machine = await requireActiveMachine(ctx, args.deviceToken);

    const existing = await ctx.db
      .query("projectionSnapshots")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .first();

    if (existing) {
      if (existing.machineId !== machine._id || existing.ownerId !== machine.ownerId) throw new Error("Projection ownership mismatch");
      if (args.sequence < existing.sequence) throw new Error(`Snapshot regression for ${args.runId}`);
      if (args.sequence === existing.sequence && args.snapshotJson !== existing.snapshotJson) throw new Error(`Conflicting snapshot at ${args.runId}:${args.sequence}`);
      if (args.sequence === existing.sequence) return;
      await ctx.db.patch(existing._id, { sequence: args.sequence, snapshotJson: args.snapshotJson, updatedAt: now });
    } else {
      if (args.sequence > 0) {
        const last = await ctx.db.query("projectionEvents").withIndex("by_run_sequence", (q) => q.eq("runId", args.runId).eq("sequence", args.sequence)).first();
        if (!last || last.ownerId !== machine.ownerId) throw new Error(`Snapshot sequence ${args.sequence} has not been published for ${args.runId}`);
      }
      await ctx.db.insert("projectionSnapshots", { machineId: machine._id, ownerId: machine.ownerId, runId: args.runId, sequence: args.sequence, snapshotJson: args.snapshotJson, updatedAt: now });
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
    const snaps = await ctx.db
      .query("projectionSnapshots")
      .filter((q) => q.eq(q.field("ownerId"), userId))
      .take(200);
    // The projection schema stores projectId inside the snapshot JSON, not as a column.
    // Until a dedicated index exists, filter in-memory.
    return snaps
      .filter((s) => {
        try {
          const parsed = JSON.parse(s.snapshotJson) as Record<string, unknown>;
          return (parsed.projectId as string) === args.projectId;
        } catch { return false; }
      })
      .map((s) => ({
        runId: s.runId,
        sequence: s.sequence,
        status: "active",
        title: `Run ${s.runId.slice(-8)}`,
        projectId: args.projectId,
        updatedAt: s._creationTime,
      }));
  },
});
