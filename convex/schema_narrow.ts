// ---------------------------------------------------------------------------
// Schema narrowing migration helpers
// ---------------------------------------------------------------------------
// Read-only diagnostics queries used to verify that the cutover to kernel
// projections is safe before narrowing/deleting legacy tables.
// ---------------------------------------------------------------------------

import { query } from "./_generated/server";

/** Return counts of projection snapshots to verify data migration completed. */
export const countProjectionSnapshots = query({
  handler: async (ctx) => {
    const snaps = await ctx.db.query("projectionSnapshots").take(1000);
    return { projectionSnapshotCount: snaps.length };
  },
});

/** Return counts of projection events to verify event migration completed. */
export const countProjectionEvents = query({
  handler: async (ctx) => {
    const events = await ctx.db.query("projectionEvents").take(1000);
    return { projectionEventCount: events.length };
  },
});

/** Comprehensive readiness check for legacy deletion. */
export const checkNarrowReadiness = query({
  handler: async (ctx) => {
    const snaps = await ctx.db.query("projectionSnapshots").take(1);
    const events = await ctx.db.query("projectionEvents").take(1);

    return {
      projectionHasSnapshots: snaps.length > 0,
      projectionHasEvents: events.length > 0,
      readyToNarrow: snaps.length > 0 && events.length > 0,
    };
  },
});
