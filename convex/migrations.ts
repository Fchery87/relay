import { internalMutation } from "./_generated/server";

/**
 * Backfill existing thread/message/event/approval/checkpoint metadata
 * into initial kernel projection snapshots. Idempotent — rerun is safe.
 *
 * Usage:
 *   npx convex run migrations:backfillRunProjection
 *   npx convex run migrations:verifyRunProjection
 */

export const backfillRunProjection = internalMutation({
  handler: async (ctx) => {
    const threads = await ctx.db.query("threads").order("asc").take(100);
    for (const thread of threads) {
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

export const verifyRunProjection = internalMutation({
  handler: async (ctx) => {
    const snapshots = await ctx.db.query("projectionSnapshots").order("asc").take(100);
    for (const snap of snapshots) {
      const thread = await ctx.db.get(snap.runId as never);
      if (!thread) {
        console.warn(`Orphaned projection snapshot: ${snap.runId}`);
      }
    }
    console.log(`Verified ${snapshots.length} projection snapshots`);
  },
});
