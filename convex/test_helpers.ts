import type { TestConvex } from "convex-test";
import { digestSecret } from "./auth_helpers";
import schema from "./schema";

export async function createAuthenticatedProject(t: TestConvex<typeof schema>, deviceToken = "d".repeat(32)) {
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const deviceTokenHash = await digestSecret(deviceToken);
  const { machineId, projectId } = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { daemonVersion: "test", deviceTokenHash, lastHeartbeatAt: Date.now(), name: "test-machine", ownerId: userId, platform: "linux" });
    const projectId = await ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
    return { machineId, projectId };
  });
  return { deviceToken, machineId, owner: t.withIdentity({ subject: `${userId}|session` }), projectId, userId };
}
