/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";

const modules = import.meta.glob("./**/*.ts");

test("a risky tool pauses for approval and a denial is audit logged", async () => {
  const t = convexTest(schema, modules);
  const threadId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { daemonVersion: "test", deviceToken: "device", lastHeartbeatAt: Date.now(), name: "machine", platform: "linux" });
    const projectId = await ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
    return ctx.db.insert("threads", { projectId, status: "running", title: "governance" });
  });

  const approvalId = await t.mutation(api.approvals.create, { capability: "exec", risk: "high", summary: "rm -f output.txt", threadId });
  const pausedThread = await t.run((ctx) => ctx.db.get("threads", threadId));
  expect(pausedThread?.status).toBe("awaiting-approval");
  expect(await t.query(api.approvals.get, { approvalId })).toMatchObject({ decision: "pending", summary: "rm -f output.txt" });

  await t.mutation(api.approvals.resolve, { approvalId, decision: "deny" });
  const resumedThread = await t.run((ctx) => ctx.db.get("threads", threadId));
  expect(resumedThread?.status).toBe("running");
  expect(await t.query(api.audit_log.listForThread, { threadId })).toMatchObject([
    { capability: "exec", decision: "ask", risk: "high" },
    { capability: "exec", decision: "deny", risk: "high" },
  ]);
});

test("approval resolution restores the thread status that was paused", async () => {
  const t = convexTest(schema, modules);
  const threadId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { daemonVersion: "test", deviceToken: "device", lastHeartbeatAt: Date.now(), name: "machine", platform: "linux" });
    const projectId = await ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
    return ctx.db.insert("threads", { projectId, status: "done", title: "command" });
  });
  const approvalId = await t.mutation(api.approvals.create, { capability: "exec", risk: "high", summary: "rm -f output.txt", threadId });
  await t.mutation(api.approvals.resolve, { approvalId, decision: "deny" });
  expect((await t.run((ctx) => ctx.db.get("threads", threadId)))?.status).toBe("done");
});
