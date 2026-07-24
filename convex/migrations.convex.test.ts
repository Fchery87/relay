/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";
import { digestSecret } from "./auth_helpers";

const modules = import.meta.glob("./**/*.ts");

test("backfills machine ownership on legacy queued messages", async () => {
  const t = convexTest(schema, modules);
  const deviceTokenHash = await digestSecret("migration-device");
  const { machineId, threadId, messageId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const machineId = await ctx.db.insert("machines", {
      daemonVersion: "test",
      deviceTokenHash,
      lastHeartbeatAt: Date.now(),
      name: "migration-machine",
      ownerId: userId,
      platform: "linux",
    });
    const projectId = await ctx.db.insert("projects", { machineId, name: "migration", path: "/migration" });
    const threadId = await ctx.db.insert("threads", { projectId, status: "queued", title: "migration" });
    const messageId = await ctx.db.insert("messages", { content: "legacy", queuedThreadId: threadId, role: "user", status: "queued", threadId });
    return { machineId, messageId, threadId };
  });

  await expect(t.mutation(internal.migrations.backfillQueuedMessageMachineIds, { cursor: null, limit: 10 })).resolves.toMatchObject({ updated: 1 });
  await expect(t.run((ctx) => ctx.db.get(messageId))).resolves.toMatchObject({ machineId, threadId });
});
