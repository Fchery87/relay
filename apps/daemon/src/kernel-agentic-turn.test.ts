import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeKernelAgenticTurn, resumeKernelAgenticTurn } from "./kernel-agentic-turn";
import type { TurnModelProvider, TurnStreamEvent } from "./turn-loop";
import type { Policy } from "./policy";

class ScriptedTurnProvider implements TurnModelProvider {
  readonly modelId = "test";
  #iterations: TurnStreamEvent[][];

  constructor(iterations: TurnStreamEvent[][]) {
    this.#iterations = iterations;
  }

  async *streamTurn(): AsyncIterable<TurnStreamEvent> {
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
