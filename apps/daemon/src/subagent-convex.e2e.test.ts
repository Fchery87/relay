import { expect, test } from "bun:test";
import { convexTest } from "convex-test";

import schema from "../../../convex/schema";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { runQueuedTurn, type ConversationGateway } from "./agent-loop";
import { ScriptedModelProvider } from "./model-provider";
import { runQueuedSubagent } from "./subagent-worker";

const modules = {
  "./_generated/server.js": () => import("../../../convex/_generated/server.js"),
  "./conversations.ts": () => import("../../../convex/conversations"),
  "./subagents.ts": () => import("../../../convex/subagents"),
  "./usage.ts": () => import("../../../convex/usage"),
};
test("parent delegates to a read-only explorer and its contract lands in Convex", async () => {
  const t = convexTest(schema, modules);
  const deviceToken = "d".repeat(32);
  const deviceTokenHash = await digest(deviceToken);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const owner = t.withIdentity({ subject: `${userId}|session` });
  const projectId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { capabilityCeiling: ["read", "task"], daemonVersion: "test", deviceTokenHash, lastHeartbeatAt: Date.now(), name: "machine", ownerId: userId, platform: "linux" });
    return ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
  });
  const threadId = await owner.mutation(api.conversations.createThread, { projectId, title: "delegate" });
  await t.mutation(api.subagents.seedDefaults, { deviceToken });
  await owner.mutation(api.conversations.sendUserMessage, { content: "map it", threadId });
  const gateway: ConversationGateway = {
    acknowledgeStop: async () => undefined,
    appendAssistantText: (input) => t.mutation(api.conversations.appendAssistantText, { ...input, deviceToken, messageId: input.messageId as Id<"messages"> }),
    beginAssistantMessage: (input) => t.mutation(api.conversations.beginAssistantMessage, { deviceToken, threadId: input.threadId as Id<"threads"> }),
    claimQueuedMessage: async () => ({ content: "map it", projectPath: "/repo", reviewComments: [], threadId, thinkingLevel: "none" }),
    claimSteeringMessages: async () => [],
    completeAssistantMessage: ({ messageId }) => t.mutation(api.conversations.completeAssistantMessage, { deviceToken, messageId: messageId as Id<"messages">, status: "done", threadId }),
    enqueueSubagent: (input) => t.mutation(api.subagents.enqueueByName, { ...input, deviceToken, threadId: input.threadId as Id<"threads"> }),
    isStopRequested: async () => false,
    recordUsage: async () => undefined,
  };
  await runQueuedTurn({ deviceToken, gateway, governance: { recordDecision: async () => undefined, requestApproval: async () => "allow" }, policy: { rules: [{ capability: "read", decision: "allow", risk: "low" }, { capability: "task", decision: "allow", risk: "low" }] }, provider: new ScriptedModelProvider({ chunks: ["delegated"], toolCalls: [{ capabilities: ["read"], kind: "task", role: "explore", task: "Map the repo" }] }) });
  await runQueuedSubagent({
    gateway: {
      claim: () => t.mutation(api.subagents.claim, { deviceToken }),
      complete: (input) => t.mutation(api.subagents.complete, { ...input, deviceToken, runId: input.runId as Id<"subagentRuns"> }),
    },
    provider: new ScriptedModelProvider({ chunks: [JSON.stringify({ artifacts: [], findings: ["src/index.ts:1"], status: "success", summary: "Mapped." })] }),
    resolveProjectRoot: async () => "/repo",
  });
  expect(await owner.query(api.subagents.listTree, { threadId })).toMatchObject([{ capabilities: ["read"], depth: 1, result: { findings: ["src/index.ts:1"], status: "success" }, status: "complete" }]);
});

async function digest(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
