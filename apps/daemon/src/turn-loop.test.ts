import { expect, test } from "bun:test";

import { runAgenticTurn, type ChatMessage, type TurnModelProvider, type TurnStreamEvent } from "./turn-loop";
import type { TokenUsage } from "@relay/shared";
import type { ToolCall } from "./tool-executor";

const zeroUsage: TokenUsage = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };

class FakeTurnProvider implements TurnModelProvider {
  readonly modelId = "fake";
  #script: TurnStreamEvent[][];
  #iteration = 0;

  constructor(script: TurnStreamEvent[][]) {
    this.#script = script;
  }

  async *streamTurn(): AsyncIterable<TurnStreamEvent> {
    if (this.#iteration >= this.#script.length) {
      yield { kind: "stop", reason: "end_turn" };
      return;
    }
    const events = this.#script[this.#iteration]!;
    this.#iteration++;
    for (const event of events) {
      yield event;
    }
  }
}

function fakeStop(reason: "end_turn" | "max_tokens" | "tool_use"): TurnStreamEvent {
  return { kind: "stop", reason };
}

test("read→edit sequence across multiple iterations", async () => {
  const controller = new AbortController();
  const executed: Array<{ call: ToolCall; result: string }> = [];
  const callbacks = {
    executeToolCall: async (call: ToolCall) => {
      if (call.kind === "read") {
        executed.push({ call, result: "file contents here" });
        return { content: "file contents here", toolUseId: "read-1" };
      }
      if (call.kind === "edit") {
        executed.push({ call, result: "edited" });
        return { content: "edited", toolUseId: "edit-1" };
      }
      return { content: "done", toolUseId: call.kind };
    },
  };

  const provider = new FakeTurnProvider([
    // Iteration 1: read tool call
    [
      { kind: "tool_use", call: { kind: "read", path: "file.txt" }, id: "read-1" },
      fakeStop("tool_use"),
    ],
    // Iteration 2: edit tool call (after receiving read results)
    [
      { kind: "tool_use", call: { content: "new content", kind: "edit", path: "file.txt" }, id: "edit-1" },
      fakeStop("tool_use"),
    ],
    // Iteration 3: text + end
    [
      { kind: "text", text: "Done editing" },
      { kind: "usage", usage: { ...zeroUsage, outputTokens: 50 } },
      fakeStop("end_turn"),
    ],
  ]);

  const result = await runAgenticTurn({
    messages: [{ content: "edit file.txt", role: "user" }],
    provider,
    signal: controller.signal,
    system: "You are a helper.",
    tools: [],
    callbacks,
  });

  expect(executed).toHaveLength(2);
  expect(executed[0]!.call.kind).toBe("read");
  expect(executed[1]!.call.kind).toBe("edit");
  expect(result.messages).toHaveLength(6); // user, assistant(tool_use), tool_results, assistant(tool_use), tool_results, assistant(text)
  expect(result.totalUsage.outputTokens).toBe(50);
});

test("refused call produces isError tool_result and loop continues", async () => {
  const controller = new AbortController();
  const callbacks = {
    executeToolCall: async (_call: ToolCall) => {
      return { content: "policy_denied", isError: true, toolUseId: "bash-1" };
    },
  };

  const provider = new FakeTurnProvider([
    [
      { kind: "tool_use", call: { command: "rm -rf /", kind: "bash" }, id: "bash-1" },
      fakeStop("tool_use"),
    ],
    [
      { kind: "text", text: "I was denied, let me try something else" },
      { kind: "usage", usage: zeroUsage },
      fakeStop("end_turn"),
    ],
  ]);

  const result = await runAgenticTurn({
    messages: [{ content: "delete everything", role: "user" }],
    provider,
    signal: controller.signal,
    system: "",
    tools: [],
    callbacks,
  });

  const toolResultMsg = result.messages.find((m) => m.role === "tool_results");
  expect(toolResultMsg).toBeDefined();
  if (toolResultMsg && toolResultMsg.role === "tool_results") {
    expect(toolResultMsg.results[0]!.isError).toBe(true);
    expect(toolResultMsg.results[0]!.content).toBe("policy_denied");
  }
  expect(result.messages.length).toBeGreaterThanOrEqual(4);
});

test("maxIterations exceeded stops the loop", async () => {
  const controller = new AbortController();
  const callbacks = {
    executeToolCall: async () => ({ content: "ok", toolUseId: "t" }),
  };

  const provider = new FakeTurnProvider(
    Array.from({ length: 10 }, () => [
      { kind: "tool_use", call: { kind: "read", path: "x" }, id: "r" },
      fakeStop("tool_use"),
    ]),
  );

  const result = await runAgenticTurn({
    messages: [{ content: "loop", role: "user" }],
    maxIterations: 3,
    provider,
    signal: controller.signal,
    system: "",
    tools: [],
    callbacks,
  });

  // 3 iterations = 3 assistant messages + 3 tool_results + 1 initial user = 7 messages
  expect(result.messages.length).toBeLessThanOrEqual(7);
});

test("steering message lands between iterations", async () => {
  const controller = new AbortController();
  let steeringClaimed = 0;
  const callbacks = {
    executeToolCall: async () => ({ content: "ok", toolUseId: "t" }),
    claimSteering: async () => {
      if (steeringClaimed === 0) {
        steeringClaimed++;
        return ["change direction"];
      }
      return [];
    },
  };

  const provider = new FakeTurnProvider([
    [
      { kind: "tool_use", call: { kind: "read", path: "x" }, id: "r" },
      fakeStop("tool_use"),
    ],
    [
      { kind: "text", text: "Steered response" },
      { kind: "usage", usage: zeroUsage },
      fakeStop("end_turn"),
    ],
  ]);

  const result = await runAgenticTurn({
    messages: [{ content: "start", role: "user" }],
    provider,
    signal: controller.signal,
    system: "",
    tools: [],
    callbacks,
  });

  const steeringMsg = result.messages.find((m) => m.role === "user" && m.content === "change direction");
  expect(steeringMsg).toBeDefined();
});

test("abort signal stops the loop cleanly", async () => {
  const controller = new AbortController();
  const callbacks = {
    executeToolCall: async () => ({ content: "ok", toolUseId: "t" }),
  };

  const provider = new FakeTurnProvider([
    [
      { kind: "text", text: "partial" },
    ],
  ]);

  const promise = runAgenticTurn({
    messages: [{ content: "go", role: "user" }],
    maxIterations: 10,
    provider,
    signal: controller.signal,
    system: "",
    tools: [],
    callbacks,
  });

  // Abort during streaming
  await Bun.sleep(10);
  controller.abort();

  const result = await promise;
  // Should exit cleanly without throwing
  expect(result.messages.length).toBeGreaterThan(0);
});

test("usage from every iteration is summed", async () => {
  const controller = new AbortController();
  const callbacks = {
    executeToolCall: async () => ({ content: "ok", toolUseId: "t" }),
  };

  const provider = new FakeTurnProvider([
    [
      { kind: "tool_use", call: { kind: "read", path: "x" }, id: "r" },
      { kind: "usage", usage: { ...zeroUsage, inputTokens: 100, outputTokens: 50 } },
      fakeStop("tool_use"),
    ],
    [
      { kind: "text", text: "done" },
      { kind: "usage", usage: { ...zeroUsage, inputTokens: 80, outputTokens: 30 } },
      fakeStop("end_turn"),
    ],
  ]);

  const result = await runAgenticTurn({
    messages: [{ content: "go", role: "user" }],
    provider,
    signal: controller.signal,
    system: "",
    tools: [],
    callbacks,
  });

  expect(result.totalUsage.inputTokens).toBe(180);
  expect(result.totalUsage.outputTokens).toBe(80);
});
