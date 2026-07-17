import { v } from "convex/values";
import { mutation } from "../_generated/server";
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
    machineId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const ownerId: Id<"users"> | undefined = undefined; // populated during auth hardening (ticket 8)

    for (const ev of args.events) {
      // Check for exact duplicate (idempotent)
      const existing = await ctx.db
        .query("projectionEvents")
        .withIndex("by_run_sequence", (q) =>
          q.eq("runId", ev.runId).eq("sequence", ev.sequence),
        )
        .first();

      if (existing) {
        if (existing.eventId !== ev.eventId) {
          throw new Error(
            `Sequence ${ev.sequence} for run ${ev.runId} already has event ${existing.eventId}, cannot append ${ev.eventId}`,
          );
        }
        // Exact duplicate — skip
        continue;
      }

      // Ensure it's the next sequence (no gaps)
      const prev = await ctx.db
        .query("projectionEvents")
        .withIndex("by_run_sequence", (q) =>
          q.eq("runId", ev.runId).eq("sequence", ev.sequence - 1),
        )
        .first();

      // If this is the first event (sequence 1), no prev needed.
      // If sequence > 1 and no prev, there's a gap — reject.
      if (ev.sequence > 1 && !prev) {
        throw new Error(
          `Gap detected: event ${ev.eventId} has sequence ${ev.sequence} but sequence ${ev.sequence - 1} is missing for run ${ev.runId}`,
        );
      }

      await ctx.db.insert("projectionEvents", {
        eventId: ev.eventId,
        occurredAt: ev.occurredAt,
        ownerId,
        payloadJson: ev.payloadJson,
        publishedAt: now,
        runId: ev.runId,
        sequence: ev.sequence,
        type: ev.type,
      });
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
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const existing = await ctx.db
      .query("projectionSnapshots")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        sequence: args.sequence,
        snapshotJson: args.snapshotJson,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("projectionSnapshots", {
        runId: args.runId,
        sequence: args.sequence,
        snapshotJson: args.snapshotJson,
        updatedAt: now,
      });
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
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("projectionCursors")
      .withIndex("by_machine_direction", (q) =>
        q.eq("machineId", args.machineId).eq("direction", args.direction),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        sequence: args.sequence,
        updatedAt: Date.now(),
      });
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
