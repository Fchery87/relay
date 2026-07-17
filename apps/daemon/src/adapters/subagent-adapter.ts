// ---------------------------------------------------------------------------
// Subagent adapter — executes a subagent task through the provider and
// produces canonical activity + checkpoint events.
//
// In kernel mode, subagent tasks arrive via the command inbox (kind:
// "subagent.run") rather than through a separate Convex claim gateway.
// ---------------------------------------------------------------------------

import type { ModelProvider, ModelProviderRouter } from "../model-provider";
import { DEFAULT_MODEL_ID, type Capability, type MachinePlatform } from "@relay/shared";
import { buildTurnPrompt, type ReviewComment } from "../agent-loop";
import { computeDiff } from "../git-review";
import { createCheckpoint } from "../checkpoints";

export type SubagentAdapterDeps = {
  provider: ModelProvider | ModelProviderRouter;
  platform: MachinePlatform;
  resolveProjectRoot(input: { repoPath: string; threadId: string }): Promise<string>;
};

export type SubagentInput = {
  task: string;
  roleName: string;
  capabilities: Capability[];
  projectPath: string;
  threadId: string;
  modelId?: string;
  reviewComments?: ReviewComment[];
};

function isRouter(
  provider: ModelProvider | ModelProviderRouter,
): provider is ModelProviderRouter {
  return "kind" in provider && provider.kind === "model-router";
}

export async function executeSubagent(
  input: SubagentInput,
  deps: SubagentAdapterDeps,
  runId: string,
): Promise<Array<{ eventId: string; type: string; payload: Record<string, unknown> }>> {
  const events: Array<{ eventId: string; type: string; payload: Record<string, unknown> }> = [];
  const ts = Date.now();
  const activityId = `subagent-${runId}`;

  // Activity started
  events.push({
    eventId: `sub-start-${runId}-${ts}`,
    type: "activity.started",
    payload: {
      activityId,
      kind: `subagent:${input.roleName}`,
    },
  });

  const root = await deps.resolveProjectRoot({
    repoPath: input.projectPath,
    threadId: input.threadId,
  });

  const turnProvider = isRouter(deps.provider)
    ? deps.provider.resolve({
        modelId: input.modelId ?? DEFAULT_MODEL_ID,
        thinkingLevel: "none",
      })
    : deps.provider;

  const prompt = buildTurnPrompt({
    content: input.task,
    reviewComments: input.reviewComments ?? [],
  });

  let output = "";
  try {
    for await (const chunk of turnProvider.streamReply({
      prompt,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    })) {
      if (chunk.kind === "text") {
        output += chunk.text;
        events.push({
          eventId: `sub-delta-${runId}-${Date.now()}`,
          type: "activity.delta",
          payload: { activityId, content: chunk.text },
        });
      } else if (chunk.kind === "usage") {
        events.push({
          eventId: `sub-usage-${runId}-${Date.now()}`,
          type: "usage.recorded",
          payload: chunk.usage as unknown as Record<string, unknown>,
        });
      }
    }

    // Best-effort checkpoint
    try {
      const diff = await computeDiff({ root, startCommit: "HEAD" });
      if (diff.length > 0) {
        const checkpoint = await createCheckpoint({
          root,
          threadId: input.threadId,
          turnId: `turn-${runId}`,
        });
        events.push({
          eventId: `sub-ckpt-${runId}-${Date.now()}`,
          type: "checkpoint.captured",
          payload: {
            checkpointId: `ckpt-${checkpoint.commit.slice(0, 7)}`,
            commit: checkpoint.commit,
            ref: checkpoint.ref,
          },
        });
      }
    } catch {
      // Checkpointing is best-effort for subagents
    }

    events.push({
      eventId: `sub-done-${runId}-${ts}`,
      type: "activity.completed",
      payload: {
        activityId,
        kind: `subagent:${input.roleName}`,
        summary: output.slice(0, 2000),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    events.push({
      eventId: `sub-fail-${runId}-${ts}`,
      type: "activity.failed",
      payload: { activityId, error: message },
    });
  }

  return events;
}
