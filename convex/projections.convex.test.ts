/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema.ts";
import { createAuthenticatedProject } from "./test_helpers";
const modules = import.meta.glob("./**/*.ts");

test("projection namespace is bound to the authenticated machine project", async () => {
  const t = convexTest(schema, modules);
  const first = await createAuthenticatedProject(t, "a".repeat(32));
  const second = await createAuthenticatedProject(t, "b".repeat(32));
  await expect(t.mutation(api.projections.publish.appendEvents, {
    deviceToken: first.deviceToken,
    events: [{ eventId: "ev-1", occurredAt: 1, payloadJson: "{}", projectId: second.projectId, runId: "run-x", sequence: 1, type: "run.created" }],
  })).rejects.toThrow(/project does not belong to machine/);
});

test("owner lists only indexed projection snapshots for their project", async () => {
  const t = convexTest(schema, modules);
  const fixture = await createAuthenticatedProject(t, "c".repeat(32));
  await t.mutation(api.projections.publish.appendEvents, {
    deviceToken: fixture.deviceToken,
    events: [{ eventId: "ev-1", occurredAt: 1, payloadJson: "{}", projectId: fixture.projectId, runId: "run-1", sequence: 1, type: "run.created" }],
  });
  await t.mutation(api.projections.publish.upsertSnapshot, {
    deviceToken: fixture.deviceToken, projectId: fixture.projectId, runId: "run-1", sequence: 1,
    snapshotJson: JSON.stringify({ projectId: fixture.projectId, status: "running", title: "Canonical run" }),
  });
  expect(await fixture.owner.query(api.projections.publish.listProjectionRuns, { projectId: fixture.projectId })).toEqual([
    expect.objectContaining({ projectId: fixture.projectId, runId: "run-1", sequence: 1, status: "running", title: "Canonical run" }),
  ]);
  await expect(t.run((ctx) => ctx.db.query("auditLog").collect())).resolves.toEqual([
    expect.objectContaining({
      action: "projection.events.append",
      actorKind: "device",
      category: "projection",
      correlationId: "ev-1",
      projectId: fixture.projectId,
    }),
    expect.objectContaining({
      action: "projection.snapshot.upsert",
      actorKind: "device",
      category: "projection",
      projectId: fixture.projectId,
    }),
  ]);
});

test("projection reads fail closed across owners", async () => {
  const t = convexTest(schema, modules);
  const fixture = await createAuthenticatedProject(t, "e".repeat(32));
  const strangerId = await t.run((ctx) => ctx.db.insert("users", {}));
  const stranger = t.withIdentity({ subject: `${strangerId}|session` });

  await t.mutation(api.projections.publish.appendEvents, {
    deviceToken: fixture.deviceToken,
    events: [{ eventId: "ev-owner-only", occurredAt: 1, payloadJson: JSON.stringify({ text: "private" }), projectId: fixture.projectId, runId: "run-owner-only", sequence: 1, type: "assistant.delta" }],
  });
  await t.mutation(api.projections.publish.upsertSnapshot, {
    deviceToken: fixture.deviceToken,
    projectId: fixture.projectId,
    runId: "run-owner-only",
    sequence: 1,
    snapshotJson: JSON.stringify({ projectId: fixture.projectId, status: "running", title: "Private run" }),
  });
  await t.mutation(api.projections.publish.advanceCursor, {
    deviceToken: fixture.deviceToken,
    direction: "inbound",
    machineId: fixture.machineId,
    sequence: 1,
  });

  expect(await stranger.query(api.projections.publish.getRunSnapshot, { runId: "run-owner-only" })).toBeNull();
  expect(await stranger.query(api.projections.publish.listProjectionRuns, { projectId: fixture.projectId })).toEqual([]);
  expect(await stranger.query(api.projections.publish.getProjectionCursor, { direction: "inbound", machineId: fixture.machineId })).toBeNull();
  await expect(stranger.query(api.projections.publish.listRunEvents, { afterSequence: 0, limit: 20, runId: "run-owner-only" })).rejects.toThrow("Access denied");
});

test("projection attention derives blocked runs from snapshots and activity events", async () => {
  const t = convexTest(schema, modules);
  const fixture = await createAuthenticatedProject(t, "h".repeat(32));
  const runIds = ["run-approval", "run-plan", "run-failed", "run-elicitation", "run-healthy"];
  await t.mutation(api.projections.publish.appendEvents, {
    deviceToken: fixture.deviceToken,
    events: runIds.map((runId, index) => ({
      eventId: `created-${runId}`,
      occurredAt: index + 1,
      payloadJson: "{}",
      projectId: fixture.projectId,
      runId,
      sequence: 1,
      type: "run.created",
    })),
  });
  await t.mutation(api.projections.publish.appendEvents, {
    deviceToken: fixture.deviceToken,
    events: [{
      eventId: "elicitation-started",
      occurredAt: 10,
      payloadJson: JSON.stringify({ activityId: "activity-1", elicitationId: "elicitation-1", kind: "mcp:elicitation" }),
      projectId: fixture.projectId,
      runId: "run-elicitation",
      sequence: 2,
      type: "activity.started",
    }],
  });
  for (const [runId, snapshot] of [
    ["run-approval", { status: "awaiting_approval", title: "approval" }],
    ["run-plan", { mode: "plan", planPhase: "review", status: "running", title: "plan" }],
    ["run-failed", { status: "failed", title: "failed" }],
    ["run-elicitation", { status: "running", title: "question" }],
    ["run-healthy", { status: "running", title: "healthy" }],
  ] as const) {
    await t.mutation(api.projections.publish.upsertSnapshot, {
      deviceToken: fixture.deviceToken,
      projectId: fixture.projectId,
      runId,
      sequence: runId === "run-elicitation" ? 2 : 1,
      snapshotJson: JSON.stringify(snapshot),
    });
  }

  const items = await fixture.owner.query(api.projections.publish.listNeedsYou, {});
  expect(items).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "approval", threadId: "run-approval", title: "approval" }),
    expect.objectContaining({ kind: "plan-review", threadId: "run-plan", title: "plan" }),
    expect.objectContaining({ kind: "failed", threadId: "run-failed", title: "failed" }),
    expect.objectContaining({ kind: "elicitation", threadId: "run-elicitation", title: "question" }),
  ]));
  expect(items.find((item) => item.threadId === "run-healthy")).toBeUndefined();
});

test("projection outbox flush is recorded with its bounded scope", async () => {
  const t = convexTest(schema, modules);
  const fixture = await createAuthenticatedProject(t, "g".repeat(32));
  await t.mutation(api.projections.publish.appendEvents, {
    deviceToken: fixture.deviceToken,
    events: [{ eventId: "ev-flush", occurredAt: 1, payloadJson: "{}", projectId: fixture.projectId, runId: "/repo", sequence: 1, type: "run.created" }],
  });
  await t.mutation(api.projections.publish.flushOutbox, { deviceToken: fixture.deviceToken, projectId: fixture.projectId, throughSequence: 1 });
  await expect(t.run((ctx) => ctx.db.query("auditLog").collect())).resolves.toEqual([
    expect.objectContaining({ action: "projection.events.append" }),
    expect.objectContaining({ action: "projection.outbox.flush", effectiveScope: `${fixture.projectId}:1`, requestedScope: `${fixture.projectId}:1` }),
  ]);
});
