/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

test("classifies blocked runs into needs-you items and skips healthy ones", async () => {
  const t = convexTest(schema, modules);
  const { owner, projectId, userId } = await createAuthenticatedProject(t);

  const ids = await t.run(async (ctx) => {
    const base = { projectId, stopRequested: false } as const;
    return {
      approvalId: await ctx.db.insert("threads", { ...base, status: "awaiting-approval", title: "needs approval" }),
      elicitationId: await ctx.db.insert("threads", { ...base, status: "running", title: "needs answers" }),
      failedId: await ctx.db.insert("threads", { ...base, status: "failed", title: "went wrong" }),
      healthyId: await ctx.db.insert("threads", { ...base, status: "running", title: "healthy" }),
      planId: await ctx.db.insert("threads", { ...base, mode: "plan", planPhase: "review", status: "idle", title: "plan ready" }),
    };
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("mcpElicitations", { promptsJson: "[]", resumeStatus: "running", serverId: "s1", status: "pending", threadId: ids.elicitationId, toolName: "ask" });
  });

  const items = await owner.query(api.attention.listNeedsYou, {});
  const byThread = new Map(items.map((item) => [item.threadId, item]));

  expect(byThread.get(ids.approvalId)?.kind).toBe("approval");
  expect(byThread.get(ids.planId)?.kind).toBe("plan-review");
  expect(byThread.get(ids.failedId)?.kind).toBe("failed");
  expect(byThread.get(ids.elicitationId)?.kind).toBe("elicitation");
  expect(byThread.has(ids.healthyId)).toBe(false);
  expect(byThread.get(ids.approvalId)?.projectName).toBe("relay");
  expect(userId).toBeDefined();
});

test("excludes other users' runs", async () => {
  const t = convexTest(schema, modules);
  const { projectId } = await createAuthenticatedProject(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("threads", { projectId, status: "awaiting-approval", stopRequested: false, title: "not yours" });
  });

  const strangerId = await t.run((ctx) => ctx.db.insert("users", {}));
  const stranger = t.withIdentity({ subject: `${strangerId}|session` });
  expect(await stranger.query(api.attention.listNeedsYou, {})).toEqual([]);
});
