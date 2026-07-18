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

test("flushes the first token then coalesces rapid scripted chunks", async () => {
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
  expect(updates).toEqual(["Hello", "Hello world"]);
});

test("a loaded (non-builtin) slash command expands its template but stores the raw invocation in history", async () => {
  const prompts: string[] = [];
  const provider: ModelProvider = {
    async *streamReply({ prompt }) { prompts.push(prompt); yield { kind: "text", text: "ok" }; yield { kind: "usage", usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } }; },
  };
  const resolved: string[] = [];
  await runQueuedTurn({
    deviceToken: "device",
    governance,
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "/fix-issue 123", projectPath: "/tmp", threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => false,
      recordUsage: async () => undefined,
    },
    provider,
    policy,
    resolveSlashCommands: async ({ projectPath }) => { resolved.push(projectPath); return [{ name: "fix-issue", template: "Fix issue #$1 following repo conventions." }]; },
  });

  expect(resolved).toEqual(["/tmp"]);
  expect(prompts[0]).toContain("Fix issue #123 following repo conventions.");
});

test("an unknown slash command falls through as literal text", async () => {
  const prompts: string[] = [];
  const provider: ModelProvider = {
    async *streamReply({ prompt }) { prompts.push(prompt); yield { kind: "text", text: "ok" }; yield { kind: "usage", usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } }; },
  };
  await runQueuedTurn({
    deviceToken: "device",
    governance,
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "/nope some args", projectPath: "/tmp", threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => false,
      recordUsage: async () => undefined,
    },
    provider,
    policy,
    resolveSlashCommands: async () => [],
  });

  expect(prompts[0]).toContain("/nope some args");
});

test("a governed task call queues a narrowed subagent run", async () => {
  const queued: unknown[] = [];
  let waited = false;
  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined, appendAssistantText: async () => undefined, beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "delegate", projectPath: "/tmp", threadId: "thread" }), claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined, enqueueSubagent: async (input) => { queued.push(input); return "run-1"; }, isStopRequested: async () => false,
      recordUsage: async () => undefined,
      waitForSubagent: async () => { waited = true; return { artifacts: [], findings: ["README.md:1"], status: "success", summary: "Mapped." }; },
    },
    governance,
    policy: { rules: [{ capability: "read", decision: "allow", risk: "low" }, { capability: "task", decision: "allow", risk: "low" }] },
    provider: new ScriptedModelProvider({ chunks: ["Delegated"], toolCalls: [{ capabilities: ["read"], kind: "task", role: "explore", task: "Map the repo" }] }),
  });
  expect(queued).toMatchObject([{ capabilities: ["read"], depth: 1, deviceToken: "device", roleName: "explore", task: "Map the repo", threadId: "thread" }]);
  expect(waited).toBe(true);
});

test("surfaces discovered MCP tools to the provider and executes through governance", async () => {
  const seenTools: unknown[] = [];
  const calls: unknown[] = [];
  const provider: ModelProvider = {
    async *toolCalls({ tools = [] }) { seenTools.push(...tools); yield { arguments: { query: "relay" }, kind: "mcp", name: "search", risk: "low", serverId: "docs" }; },
    async *streamReply() { yield { kind: "usage", usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } }; },
  };
  await runQueuedTurn({
    deviceToken: "device", governance, policy,
    gateway: { acknowledgeStop: async () => undefined, appendAssistantText: async () => undefined, beginAssistantMessage: async () => "assistant", claimQueuedMessage: async () => ({ content: "search", projectPath: "/tmp", threadId: "thread" }), claimSteeringMessages: async () => [], completeAssistantMessage: async () => undefined, isStopRequested: async () => false, recordUsage: async () => undefined },
    mcp: { callTool: async (input) => { calls.push(input); return { content: "found" }; }, listTools: async () => [{ description: "Search docs", inputSchema: { type: "object" }, name: "search", risk: "low", serverId: "docs" }] },
    provider,
  });
  expect(seenTools).toMatchObject([{ name: "search", serverId: "docs" }]);
  expect(calls).toMatchObject([{ arguments: { query: "relay" }, name: "search", serverId: "docs" }]);
});

test("records MCP task progress as thread events", async () => {
  const statuses: string[] = [];
  await runQueuedTurn({ deviceToken: "device", governance, policy: { rules: [{ capability: "exec", decision: "allow", risk: "high" }] }, gateway: {
    acknowledgeStop: async () => undefined, appendAssistantText: async () => undefined, beginAssistantMessage: async () => "assistant", claimQueuedMessage: async () => ({ content: "run", projectPath: "/tmp", threadId: "thread" }), claimSteeringMessages: async () => [], completeAssistantMessage: async () => undefined, isStopRequested: async () => false, recordMcpTaskStatus: async ({ status }) => { statuses.push(status); }, recordUsage: async () => undefined,
  }, mcp: { listTools: async () => [], callTool: async ({ onTaskStatus }) => { onTaskStatus?.({ id: "task", status: "working" }); onTaskStatus?.({ id: "task", status: "completed" }); return {}; } }, provider: new ScriptedModelProvider({ chunks: ["done"], toolCalls: [{ arguments: {}, kind: "mcp", name: "long", risk: "high", serverId: "server" }] }) });
  expect(statuses).toEqual(["working", "completed"]);
});

test("a top-level subagent cannot exceed the parent policy ceiling", async () => {
  let queued = false;
  const prompts: string[] = [];
  const provider: ModelProvider = {
    async *toolCalls() { yield { capabilities: ["exec"], kind: "task", role: "build", task: "Run commands" } as const; },
    async *streamReply({ prompt }) { prompts.push(prompt); yield { kind: "usage", usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } } as const; },
  };
  await runQueuedTurn({ deviceToken: "device", gateway: { acknowledgeStop: async () => undefined, appendAssistantText: async () => undefined, beginAssistantMessage: async () => "assistant", claimQueuedMessage: async () => ({ content: "delegate", projectPath: "/tmp", threadId: "thread" }), claimSteeringMessages: async () => [], completeAssistantMessage: async () => undefined, enqueueSubagent: async () => { queued = true; return "run"; }, isStopRequested: async () => false, recordUsage: async () => undefined }, governance, policy: { rules: [{ capability: "task", decision: "allow", risk: "low" }] }, provider });
  expect(queued).toBe(false);
  expect(prompts[0]).toContain("capability_escalation");
});

test("an agent edit produces a diff document and commits in the fixture repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-turn-"));
  const checkpoints: Array<{ commit: string; deviceToken: string; messageId: string; ref: string; threadId: string }> = [];
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
      recordCheckpoint: async (input) => { checkpoints.push(input); },
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
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]).toMatchObject({ messageId: "assistant-message", ref: "refs/relay/checkpoints/thread/assistant-message", threadId: "thread" });
  expect((await runCommand({ command: "git show refs/relay/checkpoints/thread/assistant-message:result.txt", platform: "linux", root })).stdout).toBe("agent edit");

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

test("a planning turn persists an editable plan instead of completing a chat turn", async () => {
  const plans: unknown[] = [];
  const usageRoles: string[] = [];
  let completed = false;
  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined, appendAssistantText: async () => undefined, beginAssistantMessage: async () => "plan-message",
      claimQueuedMessage: async () => ({ content: "Plan it", modelId: "deepseek/deepseek-v4-flash", planPhase: "planning", projectPath: "/tmp", threadId: "thread" }),
      claimSteeringMessages: async () => [], completeAssistantMessage: async () => { completed = true; }, completePlanning: async (input) => { plans.push(input); },
      isStopRequested: async () => false, recordUsage: async ({ role }) => { usageRoles.push(role); },
    },
    governance, policy, provider: new ScriptedModelProvider({ chunks: ["1. Inspect\n2. Implement"] }),
  });
  expect(plans).toEqual([{ content: "1. Inspect\n2. Implement", messageId: "plan-message", threadId: "thread" }]);
  expect(usageRoles).toEqual(["planner"]);
  expect(completed).toBe(false);
});

test("planning cannot mutate the worktree before approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-plan-readonly-"));
  await runQueuedTurn({ deviceToken: "device", gateway: { acknowledgeStop: async () => undefined, appendAssistantText: async () => undefined, beginAssistantMessage: async () => "plan", claimQueuedMessage: async () => ({ content: "Plan", planPhase: "planning", projectPath: root, threadId: "thread" }), claimSteeringMessages: async () => [], completeAssistantMessage: async () => undefined, completePlanning: async () => undefined, isStopRequested: async () => false, recordUsage: async () => undefined }, governance, policy, provider: new ScriptedModelProvider({ chunks: ["Plan only"], toolCalls: [{ content: "not approved", kind: "edit", path: "blocked.txt" }] }) });
  expect(access(join(root, "blocked.txt"))).rejects.toThrow();
});

test("submits normalized usage once when a scripted turn completes", async () => {
  const recorded: unknown[] = [];
  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "hello", modelId: "deepseek/deepseek-v4-flash", projectPath: "/tmp", threadId: "thread" }),
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
    modelId: "deepseek/deepseek-v4-flash",
    role: "primary",
    threadId: "thread",
  });
});

test("does not complete a turn when the provider omits usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-missing-usage-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test && git commit --allow-empty -m base", platform: "linux", root });
  const completionStatuses: Array<string | undefined> = [];
  let recorded = false;
  const checkpoints: string[] = [];
  await expect(runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "hello", projectPath: root, threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async ({ status }) => { completionStatuses.push(status); },
      isStopRequested: async () => false,
      recordCheckpoint: async ({ commit }) => { checkpoints.push(commit); },
      recordUsage: async () => { recorded = true; },
    },
    governance,
    policy,
    provider: {
      async *streamReply() { yield { kind: "text", text: "partial" } as const; },
      async *toolCalls() { yield { content: "changed", kind: "edit", path: "result.txt" } as const; },
    },
  })).rejects.toThrow("did not report usage");
  expect(recorded).toBe(false);
  // The turn is reported failed (not silently left "running") so the thread can claim its next queued message.
  expect(completionStatuses).toEqual(["failed"]);
  expect(checkpoints).toHaveLength(1);
});

test("marks the turn failed so a later message on the same thread can still be claimed", async () => {
  const completions: Array<{ messageId: string; status?: string; threadId: string }> = [];
  await expect(runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "hello", projectPath: "/tmp", threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async (input) => { completions.push(input); },
      isStopRequested: async () => false,
      recordUsage: async () => undefined,
    },
    governance,
    policy,
    provider: {
      async *streamReply() { throw new Error("deepseek tool response failed: 401"); },
    },
  })).rejects.toThrow("deepseek tool response failed: 401");

  expect(completions).toEqual([{ messageId: "assistant-message", status: "failed", threadId: "thread" }]);
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

test("flushes the first streamed token within the 200 ms latency budget", async () => {
  const flushTimes: number[] = [];
  let firstTokenAt = 0;
  const provider: ModelProvider = {
    async *streamReply() {
      firstTokenAt = Date.now();
      yield { kind: "text", text: "first" } as const;
      await Bun.sleep(250);
      yield { kind: "text", text: "second" } as const;
      yield { kind: "usage", usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } } as const;
    },
  };

  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => { flushTimes.push(Date.now()); },
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "Stream a reply", projectPath: "/tmp", threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => false,
      recordUsage: async () => undefined,
    },
    governance: { recordDecision: async () => undefined, requestApproval: async () => "allow" },
    policy: { rules: [] },
    provider,
  });

  expect(flushTimes[0]! - firstTokenAt).toBeLessThanOrEqual(200);
});

test("Stop during streaming checkpoints mutations before ending the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-stream-stop-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test && git commit --allow-empty -m base", platform: "linux", root });
  let stopChecks = 0;
  const checkpoints: string[] = [];
  const provider: ModelProvider = {
    async *streamReply({ signal }) {
      yield { kind: "text", text: "partial" };
      while (!signal.aborted) await Bun.sleep(5);
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
    async *toolCalls() { yield { content: "changed", kind: "edit", path: "result.txt" }; },
  };

  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "start", projectPath: root, threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => { stopChecks += 1; return stopChecks > 3; },
      recordCheckpoint: async ({ commit }) => { checkpoints.push(commit); },
      recordUsage: async () => undefined,
    },
    governance,
    policy,
    provider,
  });

  expect(checkpoints).toHaveLength(1);
  expect((await runCommand({ command: `git show ${checkpoints[0]}:result.txt`, platform: "linux", root })).stdout).toBe("changed");
});

test("full-access profile auto-approves high-risk commands that base policy would ask", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-full-access-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test && git commit --allow-empty -m base", platform: "linux", root });
  let approvalRequests = 0;
  let decisions: string[] = [];
  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "clean up", permissionProfile: "full-access", projectPath: root, threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => false,
      recordUsage: async () => undefined,
    },
    governance: {
      recordDecision: async ({ decision }) => { decisions.push(decision); },
      requestApproval: async () => { approvalRequests += 1; return "allow"; },
    },
    policy: { rules: [{ capability: "exec", decision: "ask", risk: "high" }] },
    provider: new ScriptedModelProvider({ chunks: ["done"], toolCalls: [{ command: "rm -rf build", kind: "bash" }] }),
  });
  expect(approvalRequests).toBe(0);
  expect(decisions).toEqual(["allow"]);
});

test("read-only profile denies edit tool calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-readonly-"));
  const prompts: string[] = [];
  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "edit this", permissionProfile: "read-only", projectPath: root, threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => false,
      recordUsage: async () => undefined,
    },
    governance,
    policy,
    provider: new ScriptedModelProvider({ chunks: ["denied"], toolCalls: [{ content: "new content", kind: "edit", path: "test.txt" }] }),
  });
  expect(access(join(root, "test.txt"))).rejects.toThrow();
});

test("yolo mode bypasses all permission checks even with workspace-write profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-yolo-"));
  await runCommand({ command: "git init && git config user.email test@example.com && git config user.name Test && git commit --allow-empty -m base", platform: "linux", root });
  let approvalRequests = 0;
  let decisions: string[] = [];
  await runQueuedTurn({
    deviceToken: "device",
    gateway: {
      acknowledgeStop: async () => undefined,
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({ content: "go", permissionProfile: "workspace-write", projectPath: root, threadId: "thread" }),
      claimSteeringMessages: async () => [],
      completeAssistantMessage: async () => undefined,
      isStopRequested: async () => false,
      recordUsage: async () => undefined,
    },
    governance: {
      recordDecision: async ({ decision }) => { decisions.push(decision); },
      requestApproval: async () => { approvalRequests += 1; return "allow"; },
    },
    policy: { rules: [{ capability: "exec", decision: "deny", risk: "critical" }] },
    provider: new ScriptedModelProvider({ chunks: ["executed"], toolCalls: [{ command: "whoami", kind: "bash" }] }),
    yolo: true,
  });
  expect(approvalRequests).toBe(0);
  expect(decisions).toEqual(["allow"]);
});
