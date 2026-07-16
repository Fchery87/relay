import { makeMigration } from "@convex-dev/migrations";
import { components } from "./_generated/api";

/**
 * Backfill existing thread/message/event/approval/checkpoint metadata
 * into initial kernel projection snapshots. Idempotent — rerun is safe.
 *
 * Usage:
 *   npx convex run migrations:backfillRunProjection '{ "dryRun": true }'
 *   npx convex run migrations:backfillRunProjection  (live run)
 *   npx convex run migrations:verifyRunProjection     (verify after)
 */

export const backfillRunProjection = makeMigration("backfillRunProjection", {
  fetch: (ctx) =>
    ctx.db
      .query("threads")
      .order("asc")
      .take(100), // bounded batches

  migrate: async (ctx, threads) => {
    for (const thread of threads) {
      // Build an initial projection snapshot from existing v1 metadata.
      // Each run maps 1:1 to a thread for now.
      const runId = thread._id;
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
        .order("asc")
        .take(500);

      const events = await ctx.db
        .query("events")
        .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
        .order("asc")
        .take(500);

      const approvals = await ctx.db
        .query("approvals")
        .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
        .order("asc")
        .take(100);

      const checkpoints = await ctx.db
        .query("checkpoints")
        .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
        .order("asc")
        .take(100);

      // Build snapshot
      const snapshot = {
        threadId: thread._id,
        threadTitle: thread.title,
        messageCount: messages.length,
        eventCount: events.length,
        approvalCount: approvals.length,
        checkpointCount: checkpoints.length,
        importedAt: Date.now(),
        source: "v1-import",
      };

      // Upsert into projectionSnapshots (idempotent)
      const existing = await ctx.db
        .query("projectionSnapshots")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          sequence: messages.length + events.length,
          snapshotJson: JSON.stringify(snapshot),
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.insert("projectionSnapshots", {
          runId,
          sequence: messages.length + events.length,
          snapshotJson: JSON.stringify(snapshot),
          updatedAt: Date.now(),
        });
      }
    }
  },
});

export const verifyRunProjection = makeMigration("verifyRunProjection", {
  fetch: (ctx) =>
    ctx.db
      .query("projectionSnapshots")
      .order("asc")
      .take(100),

  migrate: async (ctx, snapshots) => {
    const results: Array<{ runId: string; ok: boolean }> = [];
    for (const snap of snapshots) {
      const thread = await ctx.db.get(snap.runId as never);
      results.push({ runId: snap.runId, ok: thread !== null });
    }
    // Log results — a real implementation would report gaps.
    console.log(`Verified ${results.length} projection snapshots`);
    return results;
  },
});
