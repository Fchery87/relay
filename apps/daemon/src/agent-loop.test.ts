import { expect, test } from "bun:test";

import { runQueuedTurn } from "./agent-loop";
import { ScriptedModelProvider } from "./model-provider";
import { join } from "node:path";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { commitChanges, stageAll } from "./git-review";
import { runCommand } from "./tools";
import type { GovernanceGateway } from "./governed-tool-executor";
import type { Policy } from "./policy";
import type { ModelProvider } from "./model-provider";

const governance: GovernanceGateway = { recordDecision: async () => undefined, requestApproval: async () => "allow" };
const policy: Policy = { rules: [
  { capability: "edit", decision: "allow", risk: "low" },
  { capability: "exec", decision: "allow", risk: "low" },
] };

test("coalesces rapid scripted chunks into a final persisted response", async () => {
  const updates: string[] = [];
  const handled = await runQueuedTurn({
    deviceToken: "device",
    governance,
    gateway: {
      appendAssistantText: async ({ content }) => { updates.push(content); },
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "hello", projectPath: "/tmp", threadId: "thread" }),
      completeAssistantMessage: async () => undefined,
    },
    provider: new ScriptedModelProvider({ chunks: ["Hello", " world"] }),
    policy,
  });

  expect(handled).toBe(true);
  expect(updates).toEqual(["Hello world"]);
});

test("an agent edit produces a diff document and commits in the fixture repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-turn-"));
  const events: string[] = [];
  const diffs: string[] = [];
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test", platform: "linux", root });
  await runCommand({ command: "git commit --allow-empty -m base", platform: "linux", root });
  await runQueuedTurn({
    deviceToken: "device",
    governance,
    gateway: {
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "create result", projectPath: root, threadId: "thread" }),
      completeAssistantMessage: async () => undefined,
      recordToolCompleted: async ({ summary }) => { events.push(summary); },
      snapshotDiff: async ({ content }) => { diffs.push(content); },
    },
    provider: new ScriptedModelProvider({ chunks: ["Done"], toolCalls: [{ content: "agent edit", kind: "edit", path: "result.txt" }] }),
    policy,
  });
  expect(await readFile(join(root, "result.txt"), "utf8")).toBe("agent edit");
  expect(events).toEqual(["Edited result.txt"]);
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toContain("+agent edit");

  await stageAll({ root });
  const commit = await commitChanges({ message: "Apply agent edit", root });
  const head = await runCommand({ command: "git rev-parse HEAD", platform: "linux", root });
  expect(head.stdout.trim()).toBe(commit);
});

test("a denied tool call returns a structured refusal to the agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-deny-"));
  const prompts: string[] = [];
  const decisions: string[] = [];
  const provider: ModelProvider = {
    async *streamReply({ prompt }) { prompts.push(prompt); yield "Denied"; },
    async *toolCalls() { yield { command: "sudo touch blocked.txt", kind: "bash" }; },
  };
  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "run it", projectPath: root, threadId: "thread" }),
      completeAssistantMessage: async () => undefined,
    },
    governance: { recordDecision: async ({ decision }) => { decisions.push(decision); }, requestApproval: async () => "deny" },
    policy: { rules: [{ capability: "exec", decision: "deny", risk: "critical" }] },
    provider,
  });
  expect(prompts[0]).toContain("tool_refusal");
  expect(prompts[0]).toContain("policy_denied");
  expect(decisions).toEqual(["deny"]);
  expect(access(join(root, "blocked.txt"))).rejects.toThrow();
});
