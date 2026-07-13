import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { makeFunctionReference, type DefaultFunctionArgs } from "convex/server";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import schema from "../../../convex/schema";
import { runQueuedTurn, type ConversationGateway } from "./agent-loop";
import { runQueuedCheckpointRestore } from "./checkpoint-worker";
import { ScriptedModelProvider } from "./model-provider";
import { runCommand } from "./tools";

const modules = {
  "./_generated/server.js": () => import("../../../convex/_generated/server.js"),
  "./checkpoints.ts": () => import("../../../convex/checkpoints"),
  "./conversations.ts": () => import("../../../convex/conversations"),
  "./diffs.ts": () => import("../../../convex/diffs"),
  "./events.ts": () => import("../../../convex/events"),
  "./usage.ts": () => import("../../../convex/usage"),
};

const ref = <Kind extends "mutation" | "query", Args extends DefaultFunctionArgs, Result>(name: string) => makeFunctionReference<Kind, Args, Result>(name);
const createThread = ref<"mutation", { projectId: string; title: string }, string>("conversations:createThread");
const sendMessage = ref<"mutation", { content: string; threadId: string }, string>("conversations:sendUserMessage");
const claimMessage = ref<"mutation", { deviceToken: string }, unknown>("conversations:claimQueuedMessage");
const beginMessage = ref<"mutation", { threadId: string }, string>("conversations:beginAssistantMessage");
const appendText = ref<"mutation", { content: string; messageId: string }, null>("conversations:appendAssistantText");
const completeMessage = ref<"mutation", { messageId: string; status: "done"; threadId: string }, null>("conversations:completeAssistantMessage");
const recordCheckpoint = ref<"mutation", { commit: string; deviceToken: string; messageId: string; ref: string; threadId: string }, string>("checkpoints:record");
const enqueueRestore = ref<"mutation", { checkpointId: string; threadId: string }, string>("checkpoints:enqueueRestore");
const claimRestore = ref<"mutation", { deviceToken: string }, unknown>("checkpoints:claimRestore");
const completeRestore = ref<"mutation", { actionId: string; claimToken: string; deviceToken: string; status: "complete" | "failed" }, null>("checkpoints:completeRestore");
const snapshotDiff = ref<"mutation", { content: string; threadId: string }, string>("diffs:snapshot");
const listEvents = ref<"query", { threadId: string }, Array<{ kind: string }>>("events:list");
const recordUsage = ref<"mutation", Parameters<ConversationGateway["recordUsage"]>[0], string>("usage:record");

test("a Convex checkpoint action restores an agent turn and records the timeline event", async () => {
  const t = convexTest(schema, modules);
  const root = await mkdtemp(join(tmpdir(), "relay-checkpoint-convex-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test && git commit --allow-empty -m base", platform: "linux", root });
  const projectId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", { daemonVersion: "test", deviceToken: "device", lastHeartbeatAt: Date.now(), name: "machine", platform: "linux" });
    return ctx.db.insert("projects", { machineId, name: "relay", path: root });
  });
  const threadId = await t.mutation(createThread, { projectId, title: "checkpoint e2e" });
  await t.mutation(sendMessage, { content: "edit", threadId });
  let checkpointId = "";
  const gateway: ConversationGateway = {
    acknowledgeStop: async () => undefined,
    appendAssistantText: (input) => t.mutation(appendText, input),
    beginAssistantMessage: (input) => t.mutation(beginMessage, input),
    claimQueuedMessage: async (input) => {
      const value = await t.mutation(claimMessage, input);
      if (typeof value !== "object" || value === null || !("content" in value) || !("projectPath" in value) || !("threadId" in value)) throw new Error("Invalid queued message");
      return { content: String(value.content), projectPath: String(value.projectPath), threadId: String(value.threadId) };
    },
    claimSteeringMessages: async () => [],
    completeAssistantMessage: ({ messageId, threadId: id }) => t.mutation(completeMessage, { messageId, status: "done", threadId: id }),
    isStopRequested: async () => false,
    recordCheckpoint: async (input) => { checkpointId = await t.mutation(recordCheckpoint, input); },
    recordUsage: (input) => t.mutation(recordUsage, input),
  };
  await runQueuedTurn({
    deviceToken: "device",
    gateway,
    governance: { recordDecision: async () => undefined, requestApproval: async () => "allow" },
    policy: { rules: [{ capability: "edit", decision: "allow", risk: "low" }] },
    provider: new ScriptedModelProvider({ chunks: ["done"], toolCalls: [{ content: "turn one\n", kind: "edit", path: "result.txt" }] }),
  });
  await writeFile(join(root, "result.txt"), "turn two\n");
  await t.mutation(enqueueRestore, { checkpointId, threadId });

  await runQueuedCheckpointRestore({
    gateway: {
      claim: async () => {
        const value = await t.mutation(claimRestore, { deviceToken: "device" });
        if (typeof value !== "object" || value === null) return null;
        return value as { actionId: string; checkpointId: string; claimToken: string; commit: string; projectPath: string; threadId: string };
      },
      complete: (input) => t.mutation(completeRestore, { ...input, deviceToken: "device" }),
      snapshotDiff: (input) => t.mutation(snapshotDiff, input),
    },
    resolveProjectRoot: async () => root,
  });

  expect(await readFile(join(root, "result.txt"), "utf8")).toBe("turn one\n");
  expect(await t.query(listEvents, { threadId })).toMatchObject([{ kind: "checkpoint.reverted" }]);
});
