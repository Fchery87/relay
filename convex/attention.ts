import { queryGeneric } from "convex/server";

import { requireUser } from "./auth_helpers";

const MAX_THREADS_PER_PROJECT = 50;
const MAX_ITEMS = 100;

type NeedsYouKind = "approval" | "plan-review" | "elicitation" | "failed" | "trust";

/**
 * The attention inbox: every run across the user's projects that is blocked
 * waiting on the operator. Empty means every run is healthy or working.
 */
export const listNeedsYou = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const machines = await ctx.db.query("machines").withIndex("by_owner", (q) => q.eq("ownerId", userId)).collect();
    const items: Array<{ kind: NeedsYouKind; projectId: string; projectName: string; threadId: string; title: string }> = [];

    for (const machine of machines) {
      const projects = await ctx.db.query("projects").withIndex("by_machine", (q) => q.eq("machineId", machine._id)).collect();
      for (const project of projects) {
        if (items.length >= MAX_ITEMS) return items;
        if (project.trustState === "requested") {
          items.push({ kind: "trust", projectId: project._id, projectName: project.name, threadId: "" as any, title: `Trust ${project.name}` });
        }
        const threads = await ctx.db.query("threads").withIndex("by_project", (q) => q.eq("projectId", project._id)).take(MAX_THREADS_PER_PROJECT);
        for (const thread of threads) {
          if (items.length >= MAX_ITEMS) return items;
          const shared = { projectId: project._id, projectName: project.name, threadId: thread._id, title: thread.title };
          if (thread.status === "awaiting-approval") {
            items.push({ ...shared, kind: "approval" });
          } else if (thread.mode === "plan" && thread.planPhase === "review") {
            items.push({ ...shared, kind: "plan-review" });
          } else if (thread.status === "failed") {
            items.push({ ...shared, kind: "failed" });
          } else {
            const pending = await ctx.db
              .query("mcpElicitations")
              .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
              .filter((q) => q.eq(q.field("status"), "pending"))
              .first();
            if (pending) items.push({ ...shared, kind: "elicitation" });
          }
        }
      }
    }
    return items;
  },
});