import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { subagentResultSchema, type Capability, type MachinePlatform, type QueuedSubagent, type SubagentResult } from "@relay/shared";
import type { ModelProvider, ModelProviderRouter } from "./model-provider";
import { classifyToolCall, type Policy } from "./policy";
import { executeGovernedToolCall, type GovernanceGateway } from "./governed-tool-executor";
import { timedClaim } from "./observability/claim-metrics";

const INLINE_RESULT_LIMIT = 32_000;

export interface SubagentGateway {
  claim(): Promise<QueuedSubagent | null>;
  complete(input: { claimToken: string; result: SubagentResult; runId: string }): Promise<unknown>;
  enqueue?(input: { capabilities: Capability[]; depth: number; parentRunId: string; roleName: string; task: string; threadId: string }): Promise<string>;
  renew?(input: { claimToken: string; runId: string }): Promise<unknown>;
  wait?(input: { runId: string }): Promise<SubagentResult>;
}

export async function runQueuedSubagent({ artifactRoot, createWriterRoot, gateway, governance = NOOP_GOVERNANCE, integrateWriterRoot, platform = "linux", policy, provider, resolveParentRoot, resolveProjectRoot }: {
  artifactRoot?: string;
  createWriterRoot?: (input: { parentRoot: string; runId: string; threadId: string }) => Promise<string>;
  gateway: SubagentGateway;
  governance?: GovernanceGateway;
  integrateWriterRoot?: (input: { parentRoot: string; runId: string; threadId: string; writerRoot: string }) => Promise<string | null>;
  platform?: MachinePlatform;
  policy?: Policy;
  provider: ModelProvider | ModelProviderRouter;
  resolveParentRoot?: (input: { fallbackRoot: string; parentRunId?: string; threadId: string }) => Promise<string>;
  resolveProjectRoot(input: { repoPath: string; threadId: string }): Promise<string>;
}): Promise<boolean> {
  const run = await timedClaim("subagents.claim", () => gateway.claim(), (result) => (result ? "claimed" : "empty"));
  if (!run) return false;
  const leaseTimer = gateway.renew ? setInterval(() => void gateway.renew!({ claimToken: run.claimToken, runId: run.runId }).catch(() => undefined), 10_000) : undefined;
  try {
    const threadRoot = await resolveProjectRoot({ repoPath: run.projectPath, threadId: run.threadId });
    const parentRoot = resolveParentRoot ? await resolveParentRoot({ fallbackRoot: threadRoot, parentRunId: run.parentRunId, threadId: run.threadId }) : threadRoot;
    const root = run.writer && createWriterRoot ? await createWriterRoot({ parentRoot, runId: run.runId, threadId: run.threadId }) : parentRoot;
    const selected = isRouter(provider) ? provider.resolve({ modelId: run.modelId, thinkingLevel: run.thinkingLevel }) : provider;
    const context = run.contextMode === "fresh" ? "" : `\nParent thread worktree: ${root}`;
    const prompt = `${run.prompt}\n\nTask: ${run.task}${context}\nCapabilities: ${run.capabilities.join(", ")}.\nYou are powered by the model \`${run.modelId}\`; state this model id accurately if asked what model or provider you are.`;
    const toolResults: string[] = [];
    let turns = 0;
    if (selected.toolCalls) for await (const call of selected.toolCalls({ prompt })) {
      if (++turns > run.maxTurns) throw new Error(`Subagent exceeded maxTurns (${run.maxTurns})`);
      const required = classifyToolCall(call).capability;
      // Subagents cannot delegate web search — skip with a refusal.
      if (required === "search") throw new Error(`Subagent capability ${required} is not delegatable`);
      if (!run.capabilities.includes(required as Capability)) throw new Error(`Subagent capability ${required} is denied`);
      const executed = await executeGovernedToolCall({
        call, governance, onCompleted: async () => undefined,
        onTask: gateway.enqueue ? async (taskCall) => {
          const runId = await gateway.enqueue!({ capabilities: taskCall.capabilities, depth: run.depth + 1, parentRunId: run.runId, roleName: taskCall.role, task: taskCall.task, threadId: run.threadId });
          return JSON.stringify(gateway.wait ? await gateway.wait({ runId }) : { kind: "subagent_queued", runId });
        } : undefined,
        platform, policy: policy ?? allowEffectiveCapabilities(run.capabilities), root, threadId: run.threadId,
      });
      toolResults.push(executed.output);
    }
    let output = "";
    const responsePrompt = toolResults.length === 0 ? prompt : `${prompt}\n\n<tool_results>\n${toolResults.join("\n")}\n</tool_results>`;
    for await (const event of selected.streamReply({ prompt: responsePrompt, signal: new AbortController().signal })) if (event.kind === "text") output += event.text;
    const parsedResult = await parseAndSpillResult({ artifactRoot, output, runId: run.runId });
    const patchArtifact = run.writer && integrateWriterRoot ? await integrateWriterRoot({ parentRoot, runId: run.runId, threadId: run.threadId, writerRoot: root }) : null;
    const result = run.writer ? { ...parsedResult, artifacts: [...parsedResult.artifacts, ...(patchArtifact ? [patchArtifact] : []), `worktree:${run.runId}`] } : parsedResult;
    await gateway.complete({ claimToken: run.claimToken, result, runId: run.runId });
  } catch (error) {
    await gateway.complete({
      claimToken: run.claimToken,
      result: { artifacts: [], findings: [], status: "failed", summary: error instanceof Error ? error.message : "Subagent failed" },
      runId: run.runId,
    });
  } finally {
    if (leaseTimer) clearInterval(leaseTimer);
  }
  return true;
}

const NOOP_GOVERNANCE: GovernanceGateway = { recordDecision: async () => undefined, requestApproval: async () => "deny" };
function allowEffectiveCapabilities(capabilities: readonly Capability[]): Policy {
  return { rules: capabilities.map((capability) => ({ capability, decision: "allow" as const, risk: "low" as const })) };
}

async function parseAndSpillResult({ artifactRoot, output, runId }: { artifactRoot?: string; output: string; runId: string }): Promise<SubagentResult> {
  const parsed = subagentResultSchema.safeParse(safeJson(output));
  if (!parsed.success) throw new Error("Subagent returned an invalid result contract");
  const result = parsed.data;
  if (output.length <= INLINE_RESULT_LIMIT || !artifactRoot) return result;
  const directory = join(artifactRoot, "artifacts");
  const fileName = `${runId}.txt`;
  const path = join(directory, fileName);
  await mkdir(directory, { recursive: true });
  await writeFile(path, output, "utf8");
  return { artifacts: [`relay-artifacts/${fileName}`], findings: [], status: result.status, summary: `${result.summary.slice(0, 2_000)}\n\nFull output spilled to a daemon artifact.` };
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function isRouter(provider: ModelProvider | ModelProviderRouter): provider is ModelProviderRouter {
  return "kind" in provider && provider.kind === "model-router";
}
