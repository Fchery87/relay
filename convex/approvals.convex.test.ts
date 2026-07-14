/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

test("a risky tool pauses for approval and a denial is audit logged", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "running", title: "governance" }));

  const approvalId = await t.mutation(api.approvals.create, { capability: "exec", deviceToken, risk: "high", summary: "rm -f output.txt", threadId });
  const pausedThread = await t.run((ctx) => ctx.db.get("threads", threadId));
  expect(pausedThread?.status).toBe("awaiting-approval");
  expect(await owner.query(api.approvals.get, { approvalId })).toMatchObject({ decision: "pending", summary: "rm -f output.txt" });

  await owner.mutation(api.approvals.resolve, { approvalId, decision: "deny" });
  const resumedThread = await t.run((ctx) => ctx.db.get("threads", threadId));
  expect(resumedThread?.status).toBe("running");
  expect(await owner.query(api.audit_log.listForThread, { threadId })).toMatchObject([
    { capability: "exec", decision: "ask", risk: "high" },
    { capability: "exec", decision: "deny", risk: "high" },
  ]);
});

test("approval resolution restores the thread status that was paused", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "done", title: "command" }));
  const approvalId = await t.mutation(api.approvals.create, { capability: "exec", deviceToken, risk: "high", summary: "rm -f output.txt", threadId });
  await owner.mutation(api.approvals.resolve, { approvalId, decision: "deny" });
  expect((await t.run((ctx) => ctx.db.get("threads", threadId)))?.status).toBe("done");
});
