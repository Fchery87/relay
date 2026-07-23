import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Backfill existing thread/message/event/approval/checkpoint metadata
 * into initial kernel projection snapshots. Idempotent — rerun is safe.
 *
 * Usage:
 *   Invoke from an authenticated maintenance function; these are private
 *   internal mutations and are not public CLI endpoints.
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

/**
 * Remove pre-deviceNonce pairing records after the compatibility schema has
 * been deployed. Only claimed or expired records are eligible; an unexpired
 * waiting record is left for a later run after it expires.
 */
export const cleanupLegacyPairings = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 100)));
    const now = Date.now();
    // Read only eligibility ranges. A creation-time scan can get stuck behind
    // unrelated waiting records and never reach an old claimed record.
    const expiredPairings = await ctx.db
      .query("pairings")
      .withIndex("by_expires_at", (q) => q.lte("expiresAt", now))
      .take(limit);
    const claimedPairings = await ctx.db
      .query("pairings")
      .withIndex("by_status", (q) => q.eq("status", "claimed"))
      .take(limit);
    const pairings = [...new Map([...expiredPairings, ...claimedPairings].map((pairing) => [pairing._id, pairing])).values()];
    let deleted = 0;
    for (const pairing of pairings) {
      if (!pairing.deviceNonce && (pairing.status === "claimed" || pairing.expiresAt <= now)) {
        await ctx.db.delete(pairing._id);
        deleted += 1;
      }
    }
    return {
      deleted,
      scanned: pairings.length,
      mayHaveMore: expiredPairings.length === limit || claimedPairings.length === limit,
    };
  },
});
