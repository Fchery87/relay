import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { makeFunctionReference, type DefaultFunctionArgs } from "convex/server";

import { queuedMessageSchema } from "@relay/shared";
import schema from "../../../convex/schema";
import { runQueuedTurn, type ConversationGateway } from "./agent-loop";
import { ScriptedModelProvider, type ModelProviderRouter } from "./model-provider";

const modules = {
  "./_generated/server.js": () => import("../../../convex/_generated/server.js"),
  "./conversations.ts": () => import("../../../convex/conversations"),
  "./plans.ts": () => import("../../../convex/plans"),
  "./usage.ts": () => import("../../../convex/usage"),
};
const ref = <Kind extends "mutation" | "query", Args extends DefaultFunctionArgs, Result>(name: string) => makeFunctionReference<Kind, Args, Result>(name);
const createThread = ref<"mutation", { mode: "plan"; projectId: string; title: string }, string>("conversations:createThread");
const sendMessage = ref<"mutation", { content: string; threadId: string }, string>("conversations:sendUserMessage");
const claimMessage = ref<"mutation", { deviceToken: string }, unknown>("conversations:claimQueuedMessage");
const beginMessage = ref<"mutation", { deviceToken: string; threadId: string }, string>("conversations:beginAssistantMessage");
const appendText = ref<"mutation", { content: string; deviceToken: string; messageId: string }, null>("conversations:appendAssistantText");
const completeMessage = ref<"mutation", { deviceToken: string; messageId: string; status: "done"; threadId: string }, null>("conversations:completeAssistantMessage");
const completePlanning = ref<"mutation", { content: string; deviceToken: string; messageId: string; threadId: string }, null>("plans:completePlanning");
const updatePair = ref<"mutation", { buildModelId: string; planModelId: string; threadId: string }, null>("plans:updateModelPair");
const updateDraft = ref<"mutation", { content: string; expectedRevision: number; threadId: string }, null>("plans:updateDraft");
const approve = ref<"mutation", { content: string; expectedRevision: number; threadId: string }, null>("plans:approve");
const getPlan = ref<"query", { threadId: string }, { content: string; status: string } | null>("plans:getForThread");
const recordUsage = ref<"mutation", Parameters<ConversationGateway["recordUsage"]>[0] & { deviceToken: string }, string>("usage:record");

test("approved planner output is consumed by a different build model in the same thread", async () => {
  const t = convexTest(schema, modules);
  const deviceToken = "d".repeat(32);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const owner = t.withIdentity({ subject: `${userId}|session` });
  const projectId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { daemonVersion: "test", deviceTokenHash: await digest(deviceToken), lastHeartbeatAt: Date.now(), name: "machine", ownerId: userId, platform: "linux" });
    return ctx.db.insert("projects", { machineId, name: "relay", path: "/repo" });
  });
  const threadId = await owner.mutation(createThread, { mode: "plan", projectId, title: "Plan" });
  await owner.mutation(updatePair, { buildModelId: "openai/gpt-5-mini", planModelId: "deepseek/deepseek-chat", threadId });
  await owner.mutation(sendMessage, { content: "Plan the change", threadId });
  const gateway: ConversationGateway = {
    acknowledgeStop: async () => undefined,
    appendAssistantText: (input) => t.mutation(appendText, { ...input, deviceToken }),
    beginAssistantMessage: (input) => t.mutation(beginMessage, { ...input, deviceToken }),
    claimQueuedMessage: async (input) => queuedMessageSchema.nullable().parse(await t.mutation(claimMessage, input)),
    claimSteeringMessages: async () => [],
    completeAssistantMessage: ({ messageId, threadId: id }) => t.mutation(completeMessage, { deviceToken, messageId, status: "done", threadId: id }),
    completePlanning: (input) => t.mutation(completePlanning, { ...input, deviceToken }),
    isStopRequested: async () => false,
    recordUsage: (input) => t.mutation(recordUsage, { ...input, deviceToken }),
  };
  const selections: string[] = [];
  const router: ModelProviderRouter = { kind: "model-router", resolve: ({ modelId }) => { selections.push(modelId); return new ScriptedModelProvider({ chunks: [modelId.startsWith("deepseek/") ? "1. Original plan" : "Build complete"] }); } };
  const common = { deviceToken, gateway, governance: { recordDecision: async () => undefined, requestApproval: async () => "allow" as const }, policy: { rules: [] }, provider: router };
  await runQueuedTurn(common);
  await owner.mutation(updateDraft, { content: "1. Approved edited plan", expectedRevision: 0, threadId });
  await owner.mutation(approve, { content: "1. Approved edited plan", expectedRevision: 1, threadId });
  await runQueuedTurn(common);

  expect(selections).toEqual(["deepseek/deepseek-chat", "openai/gpt-5-mini"]);
  expect(await owner.query(getPlan, { threadId })).toMatchObject({ content: "1. Approved edited plan", status: "approved" });
});

async function digest(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
