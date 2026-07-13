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
  const projectId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { capabilityCeiling: ["read", "task"], daemonVersion: "test", deviceToken: "device", lastHeartbeatAt: Date.now(), name: "machine", platform: "linux" });
    return ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
  });
  const threadId = await t.mutation(api.conversations.createThread, { projectId, title: "delegate" });
  await t.mutation(api.subagents.seedDefaults, {});
  await t.mutation(api.conversations.sendUserMessage, { content: "map it", threadId });
  const gateway: ConversationGateway = {
    acknowledgeStop: async () => undefined,
    appendAssistantText: (input) => t.mutation(api.conversations.appendAssistantText, { ...input, messageId: input.messageId as Id<"messages"> }),
    beginAssistantMessage: (input) => t.mutation(api.conversations.beginAssistantMessage, { threadId: input.threadId as Id<"threads"> }),
    claimQueuedMessage: async () => ({ content: "map it", projectPath: "/repo", reviewComments: [], threadId, thinkingLevel: "none" }),
    claimSteeringMessages: async () => [],
    completeAssistantMessage: ({ messageId }) => t.mutation(api.conversations.completeAssistantMessage, { messageId: messageId as Id<"messages">, status: "done", threadId }),
    enqueueSubagent: (input) => t.mutation(api.subagents.enqueueByName, { ...input, threadId: input.threadId as Id<"threads"> }),
    isStopRequested: async () => false,
    recordUsage: async () => undefined,
  };
  await runQueuedTurn({ deviceToken: "device", gateway, governance: { recordDecision: async () => undefined, requestApproval: async () => "allow" }, policy: { rules: [{ capability: "read", decision: "allow", risk: "low" }, { capability: "task", decision: "allow", risk: "low" }] }, provider: new ScriptedModelProvider({ chunks: ["delegated"], toolCalls: [{ capabilities: ["read"], kind: "task", role: "explore", task: "Map the repo" }] }) });
  await runQueuedSubagent({
    gateway: {
      claim: () => t.mutation(api.subagents.claim, { deviceToken: "device" }),
      complete: (input) => t.mutation(api.subagents.complete, { ...input, deviceToken: "device", runId: input.runId as Id<"subagentRuns"> }),
    },
    provider: new ScriptedModelProvider({ chunks: [JSON.stringify({ artifacts: [], findings: ["src/index.ts:1"], status: "success", summary: "Mapped." })] }),
    resolveProjectRoot: async () => "/repo",
  });
  expect(await t.query(api.subagents.listTree, { threadId })).toMatchObject([{ capabilities: ["read"], depth: 1, result: { findings: ["src/index.ts:1"], status: "success" }, status: "complete" }]);
});
