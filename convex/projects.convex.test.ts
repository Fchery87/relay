/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import { digestSecret } from "./auth_helpers";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function createOwnerWithMachine(t: ReturnType<typeof convexTest>, deviceToken = "d".repeat(32)) {
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const deviceTokenHash = await digestSecret(deviceToken);
  const machineId = await t.run((ctx) => ctx.db.insert("machines", { daemonVersion: "test", deviceTokenHash, lastHeartbeatAt: Date.now(), name: "test", ownerId: userId, platform: "linux" }));
  const owner = t.withIdentity({ subject: `${userId}|session` });
  return { deviceToken, machineId, owner, userId };
}

test("requestAdd creates a pending project and rejects non-owners", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, machineId, owner } = await createOwnerWithMachine(t);

  const projectId = await owner.mutation(api.projects.requestAdd, { machineId, name: "new-repo", path: "/repos/new-repo" });
  const project = await t.run((ctx) => ctx.db.get(projectId));
  expect(project).toBeDefined();
  expect(project!.status).toBe("pending");

  // Non-owner rejected
  const otherUserId = await t.run((ctx) => ctx.db.insert("users", {}));
  const otherUser = t.withIdentity({ subject: `${otherUserId}|session` });
  await expect(otherUser.mutation(api.projects.requestAdd, { machineId, name: "bad", path: "/bad" })).rejects.toThrow("does not belong");
});

test("listPending returns only pending projects for the machine", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, machineId, owner } = await createOwnerWithMachine(t);

  await owner.mutation(api.projects.requestAdd, { machineId, name: "pending-project", path: "/repos/pending" });
  const pending = await t.query(api.projects.listPending, { deviceToken });
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ name: "pending-project", path: "/repos/pending" });

  // Register an active project — it should NOT appear in pending
  await t.mutation(api.machines.registerMachine, {
    daemonVersion: "test",
    deviceToken,
    name: "test",
    platform: "linux",
    projects: [{ name: "active-project", path: "/repos/active" }],
  });
  const pending2 = await t.query(api.projects.listPending, { deviceToken });
  expect(pending2).toHaveLength(1);
});

test("resolvePending transitions project to active or error", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, machineId, owner } = await createOwnerWithMachine(t);

  const projectId = await owner.mutation(api.projects.requestAdd, { machineId, name: "resolve-me", path: "/repos/resolve" });
  await t.mutation(api.projects.resolvePending, { deviceToken, projectId, ok: true });
  const project = await t.run((ctx) => ctx.db.get(projectId));
  expect(project!.status).toBe("active");
  expect(project!.error).toBeUndefined();

  const projectId2 = await owner.mutation(api.projects.requestAdd, { machineId, name: "fail-me", path: "/repos/fail" });
  await t.mutation(api.projects.resolvePending, { deviceToken, projectId: projectId2, ok: false, error: "not found" });
  const project2 = await t.run((ctx) => ctx.db.get(projectId2));
  expect(project2!.status).toBe("error");
  expect(project2!.error).toBe("not found");
});

test("claimQueuedMessage skips threads on pending or error projects", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, machineId, owner } = await createOwnerWithMachine(t);

  // A pending project
  const pendingProjectId = await owner.mutation(api.projects.requestAdd, { machineId, name: "pending", path: "/repos/pending" });
  const pendingThreadId = await owner.mutation(api.conversations.createThread, { projectId: pendingProjectId, title: "will not claim" });
  await owner.mutation(api.conversations.sendUserMessage, { content: "hello", threadId: pendingThreadId });

  const claimed = await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });
  expect(claimed).toBeNull(); // Thread on pending project is skipped
});
