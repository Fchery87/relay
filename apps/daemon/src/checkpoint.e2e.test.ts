import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runQueuedTurn, type ConversationGateway } from "./agent-loop";
import { runQueuedCheckpointRestore } from "./checkpoint-worker";
import { ScriptedModelProvider } from "./model-provider";
import { runCommand } from "./tools";

const governance = { recordDecision: async () => undefined, requestApproval: async () => "allow" as const };
const policy = { rules: [{ capability: "edit" as const, decision: "allow" as const, risk: "low" as const }] };

test("edit, snapshot, and revert restores the prior turn file state", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-checkpoint-e2e-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test && git commit --allow-empty -m base", platform: "linux", root });
  const checkpoints: Array<{ commit: string; messageId: string; ref: string }> = [];
  let turn = 0;
  const gateway: ConversationGateway = {
    acknowledgeStop: async () => undefined,
    appendAssistantText: async () => undefined,
    beginAssistantMessage: async () => `assistant-${turn}`,
    claimQueuedMessage: async () => ({ content: "edit", projectPath: root, threadId: "thread-1" }),
    claimSteeringMessages: async () => [],
    completeAssistantMessage: async () => undefined,
    isStopRequested: async () => false,
    recordCheckpoint: async ({ commit, messageId, ref }) => { checkpoints.push({ commit, messageId, ref }); },
    recordUsage: async () => undefined,
  };

  turn = 1;
  await runQueuedTurn({ deviceToken: "device", gateway, governance, policy, provider: new ScriptedModelProvider({ chunks: ["done"], toolCalls: [{ content: "turn one\n", kind: "edit", path: "result.txt" }] }) });
  turn = 2;
  await runQueuedTurn({ deviceToken: "device", gateway, governance, policy, provider: new ScriptedModelProvider({ chunks: ["done"], toolCalls: [{ content: "turn two\n", kind: "edit", path: "result.txt" }] }) });

  await runQueuedCheckpointRestore({
    gateway: {
      claim: async () => ({ actionId: "restore-1", checkpointId: "checkpoint-1", claimToken: "claim-1", commit: checkpoints[0]!.commit, projectPath: root, threadId: "thread-1" }),
      complete: async () => undefined,
    },
    resolveProjectRoot: async () => root,
  });

  expect(await readFile(join(root, "result.txt"), "utf8")).toBe("turn one\n");
  expect(checkpoints.map(({ messageId }) => messageId)).toEqual(["assistant-1", "assistant-2"]);
  expect((await runCommand({ command: "git show-ref --verify --quiet refs/relay/checkpoints/thread-1/assistant-2", platform: "linux", root })).exitCode).toBe(0);
}, 15_000);
