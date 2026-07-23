import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeKernelAgenticTurn, resumeKernelAgenticTurn } from "./kernel-agentic-turn";
import type { TurnModelProvider, TurnStreamEvent } from "./turn-loop";
import type { Policy } from "./policy";
import type { ToolCall } from "./tool-executor";

class ScriptedTurnProvider implements TurnModelProvider {
  readonly modelId = "test";
  seenTools: unknown[] = [];
  #iterations: TurnStreamEvent[][];

  constructor(iterations: TurnStreamEvent[][]) {
    this.#iterations = iterations;
  }

  async *streamTurn(input: { tools: unknown[] }): AsyncIterable<TurnStreamEvent> {
    this.seenTools = input.tools;
    for (const event of this.#iterations.shift() ?? [{ kind: "stop", reason: "end_turn" }]) yield event;
  }
}

const askPolicy: Policy = { rules: [{ capability: "read", decision: "ask", risk: "low" }] };

test("kernel approval continuation resumes the provider with the held tool result", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-kernel-agentic-"));
  try {
    await writeFile(join(root, "result.txt"), "resumed");
    let continuationJson = "";
    const provider = new ScriptedTurnProvider([
      [
        { kind: "tool_use", call: { kind: "read", path: "result.txt" }, id: "read-1" },
        { kind: "stop", reason: "tool_use" },
      ],
      [
        { kind: "text", text: "The file is resumed." },
        { kind: "stop", reason: "end_turn" },
      ],
    ]);
    const governance = {
      createApproval: async (input: { continuationJson: string }) => {
        continuationJson = input.continuationJson;
        return "approval-1";
      },
      recordDecision: async () => undefined,
      requestApproval: async () => "deny" as const,
    };
    const first = await executeKernelAgenticTurn({
      governance,
      messages: [{ content: "inspect the file", role: "user" }],
      platform: "linux",
      policy: askPolicy,
      provider,
      root,
      runId: "run-agentic",
      signal: new AbortController().signal,
      turnId: "turn-agentic",
    });

    expect(first.pending?.approvalId).toBe("approval-1");
    expect(JSON.parse(continuationJson)).toMatchObject({ toolUseId: "read-1", turnId: "turn-agentic" });

    const resumed = await resumeKernelAgenticTurn({
      continuationJson,
      governance: { ...governance, recordDecision: async () => undefined },
      platform: "linux",
      policy: { rules: [{ capability: "read", decision: "allow", risk: "low" }] },
      provider,
      resolution: "allow",
      root,
      runId: "run-agentic",
      signal: new AbortController().signal,
      turnId: "turn-agentic",
    });

    expect(resumed.events.map((event) => event.type)).toContain("assistant.delta");
    expect(resumed.events.map((event) => event.type)).toContain("activity.completed");
    expect(resumed.events.map((event) => event.type)).not.toContain("turn.completed");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("kernel agentic turns expose MCP tools and execute delegated tasks through callbacks", async () => {
  const provider = new ScriptedTurnProvider([
    [
      { kind: "tool_use", call: { capabilities: ["read"], kind: "task", role: "explore", task: "inspect the repository" }, id: "task-1" },
      { kind: "stop", reason: "tool_use" },
    ],
    [
      { kind: "text", text: "The repository was inspected." },
      { kind: "stop", reason: "end_turn" },
    ],
  ]);
  const tasks: string[] = [];

  const result = await executeKernelAgenticTurn({
    governance: { recordDecision: async () => undefined, requestApproval: async () => "deny" as const },
    messages: [{ content: "inspect", role: "user" }],
    onTask: async (call) => {
      tasks.push(call.task);
      return { events: [], output: "subagent result" };
    },
    platform: "linux",
    policy: { rules: [{ capability: "task", decision: "allow", risk: "low" }] },
    provider,
    root: "/tmp/relay-kernel-agentic",
    runId: "run-task",
    signal: new AbortController().signal,
    tools: [{ description: "Search repository", inputSchema: { type: "object" }, name: "search", risk: "low", serverId: "docs" }],
    turnId: "turn-task",
  });

  expect(tasks).toEqual(["inspect the repository"]);
  expect(provider.seenTools).toMatchObject([{ name: "search", serverId: "docs" }]);
  expect(result.events.map((event) => event.type)).toContain("turn.completed");
});

test("kernel agentic turns delegate MCP calls through the configured callback", async () => {
  const provider = new ScriptedTurnProvider([
    [
      { kind: "tool_use", call: { arguments: { query: "status" }, kind: "mcp", name: "get_status", risk: "low", serverId: "workspace" }, id: "mcp-1" },
      { kind: "stop", reason: "tool_use" },
    ],
    [
      { kind: "text", text: "The workspace is ready." },
      { kind: "stop", reason: "end_turn" },
    ],
  ]);
  const calls: Array<Extract<ToolCall, { kind: "mcp" }>> = [];

  const result = await executeKernelAgenticTurn({
    governance: { recordDecision: async () => undefined, requestApproval: async () => "deny" as const },
    messages: [{ content: "check the workspace", role: "user" }],
    onMcp: async (call) => {
      calls.push(call);
      return { ready: true };
    },
    platform: "linux",
    policy: { rules: [{ capability: "exec", decision: "allow", risk: "low" }] },
    provider,
    root: "/tmp/relay-kernel-agentic",
    runId: "run-mcp",
    signal: new AbortController().signal,
    turnId: "turn-mcp",
  });

  expect(calls).toEqual([{ arguments: { query: "status" }, kind: "mcp", name: "get_status", risk: "low", serverId: "workspace" }]);
  expect(result.events.map((event) => event.type)).toContain("turn.completed");
});
