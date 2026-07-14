import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

test("pauses a thread for MCP input and resumes it with a JSON response", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "running", title: "MCP" }));
  const elicitationId = await t.mutation(api.mcp_elicitations.create, { deviceToken, promptsJson: '[{"id":"date"}]', serverId: "travel", threadId, toolName: "book" });
  expect(await owner.query(api.mcp_elicitations.listForThread, { threadId })).toMatchObject([{ _id: elicitationId, status: "pending" }]);
  await owner.mutation(api.mcp_elicitations.submit, { elicitationId, responseJson: '{"date":"2026-08-01"}' });
  expect(await t.query(api.mcp_elicitations.get, { deviceToken, elicitationId })).toMatchObject({ responseJson: '{"date":"2026-08-01"}', status: "submitted" });
  expect(await t.run((ctx) => ctx.db.get("threads", threadId))).toMatchObject({ status: "running" });
  const cancelledId = await t.mutation(api.mcp_elicitations.create, { deviceToken, promptsJson: "[]", serverId: "travel", threadId, toolName: "book" });
  await owner.mutation(api.mcp_elicitations.cancel, { elicitationId: cancelledId });
  expect(await t.query(api.mcp_elicitations.get, { deviceToken, elicitationId: cancelledId })).toMatchObject({ status: "cancelled" });
  expect(await t.run((ctx) => ctx.db.get("threads", threadId))).toMatchObject({ status: "running" });
});
