import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import schema from "../../../convex/schema";
import { runQueuedTurn, type ConversationGateway } from "./agent-loop";
import type { GovernanceGateway } from "./governed-tool-executor";
import type { ModelProvider } from "./model-provider";
import type { Policy } from "./policy";

const modules = {
  "./_generated/server.js": () => import("../../../convex/_generated/server.js"),
  "./conversations.ts": () => import("../../../convex/conversations"),
  "./usage.ts": () => import("../../../convex/usage"),
};

const createThread = makeFunctionReference<"mutation", { projectId: string; title: string }, string>("conversations:createThread");
const sendUserMessage = makeFunctionReference<"mutation", { content: string; threadId: string }, string>("conversations:sendUserMessage");
const claimQueuedMessage = makeFunctionReference<"mutation", { deviceToken: string }, unknown>("conversations:claimQueuedMessage");
const claimSteeringMessages = makeFunctionReference<"mutation", { deviceToken: string; threadId: string }, Array<{ content: string }>>("conversations:claimSteeringMessages");
const beginAssistantMessage = makeFunctionReference<"mutation", { deviceToken: string; threadId: string }, string>("conversations:beginAssistantMessage");
const appendAssistantText = makeFunctionReference<"mutation", { content: string; deviceToken: string; messageId: string }, null>("conversations:appendAssistantText");
const completeAssistantMessage = makeFunctionReference<"mutation", { deviceToken: string; messageId: string; threadId: string; status: "done" }, null>("conversations:completeAssistantMessage");
const getStopState = makeFunctionReference<"query", { deviceToken: string; threadId: string }, { requested: boolean }>("conversations:getStopState");
const acknowledgeStop = makeFunctionReference<"mutation", { deviceToken: string; messageId: string; threadId: string }, null>("conversations:acknowledgeStop");
const recordUsage = makeFunctionReference<"mutation", Parameters<ConversationGateway["recordUsage"]>[0], string>("usage:record");
const listThreadMessages = makeFunctionReference<"query", { threadId: string }, Array<{ content: string; status: string }>>("conversations:listThreadMessages");

const governance: GovernanceGateway = { recordDecision: async () => undefined, requestApproval: async () => "allow" };
const policy: Policy = { rules: [{ capability: "exec", decision: "allow", risk: "low" }] };

test("a Convex message sent during a long tool is injected at that tool boundary", async () => {
  const t = convexTest(schema, modules);
  const deviceToken = "d".repeat(32);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const owner = t.withIdentity({ subject: `${userId}|session` });
  const root = await mkdtemp(join(tmpdir(), "relay-steering-convex-"));
  const projectId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { daemonVersion: "test", deviceTokenHash: await digest(deviceToken), lastHeartbeatAt: Date.now(), name: "machine", ownerId: userId, platform: "linux" });
    return ctx.db.insert("projects", { machineId, name: "relay", path: root });
  });
  const threadId = await owner.mutation(createThread, { projectId, title: "steering e2e" });
  await owner.mutation(sendUserMessage, { content: "start", threadId });

  const prompts: string[] = [];
  const provider: ModelProvider = {
    async *streamReply({ prompt }) {
      prompts.push(prompt);
      yield { kind: "text", text: "steered" };
      yield { kind: "usage", usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } };
    },
    async *toolCalls() { yield { command: "sleep 0.1; printf done > result.txt", kind: "bash" }; },
  };
  const gateway: ConversationGateway = {
    acknowledgeStop: (input) => t.mutation(acknowledgeStop, input),
    appendAssistantText: (input) => t.mutation(appendAssistantText, { ...input, deviceToken }),
    beginAssistantMessage: (input) => t.mutation(beginAssistantMessage, { ...input, deviceToken }),
    claimQueuedMessage: async (input) => {
      const value = await t.mutation(claimQueuedMessage, input);
      if (typeof value !== "object" || value === null || !("content" in value) || !("projectPath" in value) || !("threadId" in value)) throw new Error("Invalid queued message fixture");
      if (typeof value.content !== "string" || typeof value.projectPath !== "string" || typeof value.threadId !== "string") throw new Error("Invalid queued message fixture");
      return { content: value.content, projectPath: value.projectPath, threadId: value.threadId };
    },
    claimSteeringMessages: (input) => t.mutation(claimSteeringMessages, input),
    completeAssistantMessage: ({ messageId, threadId }) => t.mutation(completeAssistantMessage, { deviceToken, messageId, status: "done", threadId }),
    isStopRequested: async (input) => (await t.query(getStopState, input)).requested,
    recordUsage: (input) => t.mutation(recordUsage, { ...input, deviceToken }),
  };

  const turn = runQueuedTurn({ deviceToken, gateway, governance, policy, provider });
  await Bun.sleep(20);
  await owner.mutation(sendUserMessage, { content: "change direction", threadId });
  await turn;

  expect(prompts[0]).toContain("change direction");
  expect((await owner.query(listThreadMessages, { threadId })).find((message) => message.content === "change direction")?.status).toBe("complete");
});

async function digest(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
