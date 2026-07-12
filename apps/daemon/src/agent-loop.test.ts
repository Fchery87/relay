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
      acknowledgeStop: async () => undefined,
      appendAssistantText: async ({ content }) => { updates.push(content); },
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "hello", projectPath: "/tmp", threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => false,
      recordUsage: async () => undefined,
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
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "create result", projectPath: root, threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => false,
      recordUsage: async () => undefined,
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
    async *streamReply({ prompt }) {
      prompts.push(prompt);
      yield { kind: "text", text: "Denied" } as const;
      yield { kind: "usage", usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } } as const;
    },
    async *toolCalls() { yield { command: "sudo touch blocked.txt", kind: "bash" }; },
  };
  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "run it", projectPath: root, threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => false,
      recordUsage: async () => undefined,
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

test("resolves the model provider from the claimed thread selection", async () => {
  const selections: Array<{ modelId: string; thinkingLevel: string }> = [];
  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "hello", modelId: "openai/gpt-5-mini", projectPath: "/tmp", thinkingLevel: "high", threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => false,
      recordUsage: async () => undefined,
    },
    governance,
    policy,
    provider: {
      kind: "model-router",
      resolve: ({ modelId, thinkingLevel }) => {
        selections.push({ modelId, thinkingLevel });
        return new ScriptedModelProvider({ chunks: ["resolved"] });
      },
    },
  });
  expect(selections).toEqual([{ modelId: "openai/gpt-5-mini", thinkingLevel: "high" }]);
});

test("submits normalized usage once when a scripted turn completes", async () => {
  const recorded: unknown[] = [];
  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "hello", modelId: "deepseek/deepseek-chat", projectPath: "/tmp", threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => false,
      recordUsage: async (input: unknown) => { recorded.push(input); },
    },
    governance,
    policy,
    provider: new ScriptedModelProvider({
      chunks: ["done"],
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 1_000_000, outputTokens: 500_000, thinkingTokens: 0 },
    }),
  });

  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    messageId: "assistant-message",
    modelId: "deepseek/deepseek-chat",
    role: "primary",
    threadId: "thread",
  });
});

test("does not complete a turn when the provider omits usage", async () => {
  let completed = false;
  let recorded = false;
  await expect(runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "hello", projectPath: "/tmp", threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => { completed = true; },
      isStopRequested: async () => false,
      recordUsage: async () => { recorded = true; },
    },
    governance,
    policy,
    provider: { async *streamReply() { yield { kind: "text", text: "partial" } as const; } },
  })).rejects.toThrow("did not report usage");
  expect(recorded).toBe(false);
  expect(completed).toBe(false);
});

test("injects a queued steer after an in-flight tool call completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-steer-"));
  const pendingSteers: Array<{ content: string }> = [];
  const prompts: string[] = [];
  let claimCount = 0;
  const provider: ModelProvider = {
    async *streamReply({ prompt }) {
      prompts.push(prompt);
      yield { kind: "text", text: "steered" };
      yield { kind: "usage", usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } };
    },
    async *toolCalls() {
      yield { command: "sleep 0.1; printf 'first edit' > result.txt", kind: "bash" };
      yield { content: "stale plan", kind: "edit", path: "stale.txt" };
    },
  };

  const turn = runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "start", projectPath: root, threadId: "thread" }),
      claimSteeringMessages: async () => {
        claimCount += 1;
        return pendingSteers.splice(0);
      },
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => false,
      recordUsage: async () => undefined,
    },
    governance,
    policy,
    provider,
  });
  await Bun.sleep(20);
  pendingSteers.push({ content: "change direction" });
  await turn;

  expect(claimCount).toBe(1);
  expect(await readFile(join(root, "result.txt"), "utf8")).toBe("first edit");
  expect(access(join(root, "stale.txt"))).rejects.toThrow();
  expect(prompts[0]).toContain("<steering_messages>");
  expect(prompts[0]).toContain("change direction");
});

test("Stop after an in-flight tool call skips remaining tools and leaves the thread awaiting input", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-stop-tools-"));
  const acknowledgements: string[] = [];
  let completed = false;
  let stopChecks = 0;
  let streamed = false;
  const provider: ModelProvider = {
    async *streamReply() { streamed = true; yield { kind: "text", text: "unexpected" }; },
    async *toolCalls() {
      yield { content: "first", kind: "edit", path: "first.txt" };
      yield { content: "second", kind: "edit", path: "second.txt" };
    },
  };

  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async ({ messageId }) => { acknowledgements.push(messageId); },
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "start", projectPath: root, threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => { completed = true; },
      isStopRequested: async () => { stopChecks += 1; return stopChecks > 1; },
      recordUsage: async () => undefined,
    },
    governance,
    policy,
    provider,
  });

  expect(await readFile(join(root, "first.txt"), "utf8")).toBe("first");
  expect(access(join(root, "second.txt"))).rejects.toThrow();
  expect(acknowledgements).toEqual(["assistant-message"]);
  expect(streamed).toBe(false);
  expect(completed).toBe(false);
});

test("Stop aborts an in-flight model stream and persists its partial text", async () => {
  const updates: string[] = [];
  let acknowledged = false;
  let stopChecks = 0;
  const provider: ModelProvider = {
    async *streamReply({ signal }) {
      if (!signal) throw new Error("missing abort signal");
      yield { kind: "text", text: "partial" };
      while (!signal.aborted) await Bun.sleep(5);
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    },
  };

  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => { acknowledged = true; },
      appendAssistantText: async ({ content }) => { updates.push(content); },
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "start", projectPath: "/tmp", threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => { stopChecks += 1; return stopChecks > 1; },
      recordUsage: async () => undefined,
    },
    governance,
    policy,
    provider,
  });

  expect(acknowledged).toBe(true);
  expect(updates.at(-1)).toBe("partial");
});
