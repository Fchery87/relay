import { expect, test } from "bun:test";

import { buildTurnPrompt, runQueuedTurn } from "./agent-loop";
import type { ModelProvider } from "./model-provider";
import type { GovernanceGateway } from "./governed-tool-executor";
import type { Policy } from "./policy";

const governance: GovernanceGateway = { recordDecision: async () => undefined, requestApproval: async () => "allow" };
const policy: Policy = { rules: [] };

test("formats unresolved diff comments as structured review feedback", () => {
  expect(buildTurnPrompt({
    content: "Please update the implementation.",
    reviewComments: [{ commentId: "comment-1", content: "Handle the empty case.", endLine: 14, filePath: "src/parser.ts", startLine: 12 }],
  })).toBe(`Please update the implementation.

<review_feedback>
<comment id="comment-1" file="src/parser.ts" lines="12-14">
Handle the empty case.
</comment>
</review_feedback>`);
});

test("resolves only the review comments included in a successful turn", async () => {
  const prompts: string[] = [];
  const resolved: string[][] = [];
  const provider: ModelProvider = {
    async *streamReply({ prompt }) {
      prompts.push(prompt);
      yield { kind: "text", text: "Done" } as const;
      yield { kind: "usage", usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } } as const;
    },
  };

  await runQueuedTurn({
    deviceToken: "device",
    governance,
    gateway: {
      appendAssistantText: async () => undefined,
      beginAssistantMessage: async () => "assistant-message",
      claimQueuedMessage: async () => ({
        content: "Address feedback.",
        projectPath: "/tmp",
        reviewComments: [{ commentId: "comment-1", content: "Handle the empty case.", endLine: 14, filePath: "src/parser.ts", startLine: 12 }],
        threadId: "thread",
      }),
      completeAssistantMessage: async ({ resolvedCommentIds = [] }: { messageId: string; resolvedCommentIds?: string[]; threadId: string }) => { resolved.push(resolvedCommentIds); },
      recordUsage: async () => undefined,
    },
    provider,
    policy,
  });

  expect(prompts[0]).toContain("<review_feedback>");
  expect(resolved).toEqual([["comment-1"]]);
});
