import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ScriptedModelProvider } from "./model-provider";
import { runQueuedSubagent } from "./subagent-worker";
import type { SubagentResult } from "@relay/shared";

test("a read-only explorer completes a typed result contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-subagent-"));
  await writeFile(join(root, "README.md"), "Relay", "utf8");
  const completions: unknown[] = [];
  const gateway = {
    claim: async () => ({ capabilities: ["read" as const], claimToken: "lease", contextMode: "fresh" as const, depth: 1, maxTurns: 20, modelId: "test/model", projectPath: root, prompt: "Explore", roleName: "explore", runId: "run", task: "Map the repo", thinkingLevel: "none" as const, threadId: "thread", writer: false }),
    complete: async (input: unknown) => { completions.push(input); },
  };
  const provider = new ScriptedModelProvider({ chunks: [JSON.stringify({ artifacts: [], findings: ["README.md:1"], status: "success", summary: "Found Relay." })] });

  expect(await runQueuedSubagent({ gateway, provider, resolveProjectRoot: async () => root })).toBe(true);
  expect(completions).toMatchObject([{ claimToken: "lease", result: { findings: ["README.md:1"], status: "success" }, runId: "run" }]);
});

test("invalid model output fails instead of bypassing the result contract", async () => {
  const completions: Array<{ result: SubagentResult }> = [];
  await runQueuedSubagent({
    gateway: {
      claim: async () => ({ capabilities: ["read" as const], claimToken: "lease", contextMode: "fresh" as const, depth: 1, maxTurns: 20, modelId: "test/model", projectPath: "/repo", prompt: "Explore", roleName: "explore", runId: "run", task: "Map", thinkingLevel: "none" as const, threadId: "thread", writer: false }),
      complete: async (input) => { completions.push(input); },
    },
    provider: new ScriptedModelProvider({ chunks: ["not a contract"] }),
    resolveProjectRoot: async () => "/repo",
  });
  expect(completions[0]?.result).toEqual({ artifacts: [], findings: [], status: "failed", summary: "Subagent returned an invalid result contract" });
});

test("nested delegation waits for the depth-two result contract", async () => {
  let waited = false;
  const completions: unknown[] = [];
  await runQueuedSubagent({
    gateway: {
      claim: async () => ({ capabilities: ["read" as const, "task" as const], claimToken: "lease", contextMode: "fresh" as const, depth: 1, maxTurns: 20, modelId: "test/model", projectPath: "/repo", prompt: "Review", roleName: "reviewer", runId: "parent-run", task: "Review", thinkingLevel: "none" as const, threadId: "thread", writer: false }),
      complete: async (input) => { completions.push(input); },
      enqueue: async () => "child-run",
      wait: async () => { waited = true; return { artifacts: [], findings: ["child finding"], status: "success", summary: "Child complete" }; },
    },
    provider: new ScriptedModelProvider({ chunks: [JSON.stringify({ artifacts: [], findings: [], status: "success", summary: "Parent complete" })], toolCalls: [{ capabilities: ["read"], kind: "task", role: "explore", task: "Map" }] }),
    resolveProjectRoot: async () => "/repo",
  });
  expect(waited).toBe(true);
  expect(completions).toHaveLength(1);
});
