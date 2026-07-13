/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";

const modules = import.meta.glob("./**/*.ts");

test("seeds editable roles and persists a machine-scoped subagent result", async () => {
  const t = convexTest(schema, modules);
  const { threadId } = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { capabilityCeiling: ["read", "edit", "exec", "task"], daemonVersion: "test", deviceToken: "device", lastHeartbeatAt: Date.now(), name: "machine", platform: "linux" });
    const projectId = await ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
    return { threadId: await ctx.db.insert("threads", { projectId, status: "running", title: "parent" }) };
  });

  await t.mutation(api.subagents.seedDefaults, {});
  const roles = await t.query(api.subagents.listRoles, {});
  expect(roles).toHaveLength(9);
  const explore = roles.find((role) => role.name === "explore")!;
  await t.mutation(api.subagents.updateRole, { maxTurns: 12, roleId: explore._id });
  expect((await t.query(api.subagents.listRoles, {})).find((role) => role.name === "explore")?.maxTurns).toBe(12);

  const runId = await t.mutation(api.subagents.enqueue, {
    capabilities: ["read"], depth: 1, deviceToken: "device", roleId: explore._id, task: "Map the project", threadId,
  });
  const claim = await t.mutation(api.subagents.claim, { depth: 1, deviceToken: "device" });
  expect(claim).toMatchObject({ capabilities: ["read"], depth: 1, projectPath: "/repo", runId, task: "Map the project" });
  const leaseBefore = (await t.run((ctx) => ctx.db.get("subagentRuns", runId)))!.leaseExpiresAt!;
  await t.mutation(api.subagents.renewLease, { claimToken: claim!.claimToken, deviceToken: "device", runId });
  expect((await t.run((ctx) => ctx.db.get("subagentRuns", runId)))!.leaseExpiresAt).toBeGreaterThanOrEqual(leaseBefore);
  const childRunId = await t.mutation(api.subagents.enqueue, { capabilities: ["read"], depth: 2, deviceToken: "device", parentRunId: runId, roleId: explore._id, task: "Map deeper", threadId });
  const childClaim = await t.mutation(api.subagents.claim, { depth: 2, deviceToken: "device" });
  expect(childClaim).toMatchObject({ parentRunId: runId, runId: childRunId });
  await t.mutation(api.subagents.complete, { claimToken: childClaim!.claimToken, deviceToken: "device", result: { artifacts: [], findings: [], status: "success", summary: "Child done" }, runId: childRunId });
  await t.mutation(api.subagents.complete, {
    claimToken: claim!.claimToken, deviceToken: "device", result: { artifacts: [], findings: ["src/index.ts:1"], status: "success", summary: "Mapped." }, runId,
  });
  expect((await t.query(api.subagents.listTree, { threadId })).find((run) => run._id === runId)).toMatchObject({ _id: runId, result: { status: "success", summary: "Mapped." }, status: "complete" });

  await expect(t.mutation(api.subagents.enqueue, {
    capabilities: ["exec"], depth: 2, deviceToken: "device", parentRunId: runId, roleId: explore._id, task: "Escalate", threadId,
  })).rejects.toThrow("capability");
});
