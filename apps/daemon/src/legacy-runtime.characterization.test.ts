import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import schema from "../../../convex/schema";
import { runQueuedTurn, type ConversationGateway } from "./agent-loop";
import type { GovernanceGateway } from "./governed-tool-executor";
import type { ModelProvider } from "./model-provider";
import type { Policy } from "./policy";
import type { TokenUsage } from "@relay/shared";

// ---------------------------------------------------------------------------
// Convex function references for test assertions
// ---------------------------------------------------------------------------

const modules = {
  "./_generated/server.js": () => import("../../../convex/_generated/server.js"),
  "./conversations.ts": () => import("../../../convex/conversations"),
  "./usage.ts": () => import("../../../convex/usage"),
};

const createThread = makeFunctionReference<
  "mutation",
  { projectId: string; title: string },
  string
>("conversations:createThread");

const sendUserMessage = makeFunctionReference<
  "mutation",
  { content: string; threadId: string },
  string
>("conversations:sendUserMessage");

const claimQueuedMessage = makeFunctionReference<
  "mutation",
  { deviceToken: string },
  unknown
>("conversations:claimQueuedMessage");

const beginAssistantMessage = makeFunctionReference<
  "mutation",
  { deviceToken: string; threadId: string },
  string
>("conversations:beginAssistantMessage");

const appendAssistantText = makeFunctionReference<
  "mutation",
  { content: string; deviceToken: string; messageId: string },
  null
>("conversations:appendAssistantText");

const completeAssistantMessage = makeFunctionReference<
  "mutation",
  { deviceToken: string; messageId: string; threadId: string; status: "done" },
  null
>("conversations:completeAssistantMessage");

const recordUsage = makeFunctionReference<
  "mutation",
  { callId: string; messageId: string; modelId: string; role: string; threadId: string; usage: TokenUsage } & { deviceToken: string },
  string
>("usage:record");

const listThreadMessages = makeFunctionReference<
  "query",
  { threadId: string },
  Array<{ content: string; status: string; role: string }>
>("conversations:listThreadMessages");

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const defaultGovernance: GovernanceGateway = {
  recordDecision: async () => undefined,
  requestApproval: async () => "allow",
};
const defaultPolicy: Policy = {
  rules: [{ capability: "exec", decision: "allow", risk: "low" }],
};

async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function makeEchoProvider(chunk: string): ModelProvider {
  return {
    async *streamReply() {
      yield { kind: "text", text: chunk };
      yield {
        kind: "usage",
        usage: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          inputTokens: 5,
          outputTokens: 2,
          thinkingTokens: 0,
        },
      };
    },
    async *toolCalls() {},
  };
}

async function setupFixture(opts?: { deviceToken?: string }) {
  const deviceToken = opts?.deviceToken ?? "d".repeat(32);
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const owner = t.withIdentity({ subject: `${userId}|session` });
  const root = await mkdtemp(join(tmpdir(), "relay-char-"));
  const projectId = await t.run(async (ctx) => {
    const machineId = await ctx.db.insert("machines", {
      daemonVersion: "test",
      deviceTokenHash: await digest(deviceToken),
      lastHeartbeatAt: Date.now(),
      name: "char-machine",
      ownerId: userId,
      platform: "linux",
    });
    return ctx.db.insert("projects", { machineId, name: "relay", path: root });
  });
  return { deviceToken, owner, projectId, root, t };
}

type Fixture = Awaited<ReturnType<typeof setupFixture>>;

/** Build a ConversationGateway that delegates to ConvexTest mutations. */
function makeGateway(f: Fixture, overrides?: Partial<ConversationGateway>): ConversationGateway {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mt = (ref: unknown, args: Record<string, unknown>) => f.t.mutation(ref as any, args) as any;
  return {
    acknowledgeStop: () => Promise.resolve(),
    appendAssistantText: (input) =>
      mt(appendAssistantText, { ...input, deviceToken: f.deviceToken }),
    beginAssistantMessage: (input) =>
      mt(beginAssistantMessage, { ...input, deviceToken: f.deviceToken }),
    claimQueuedMessage: async (input) => {
      const value = (await mt(claimQueuedMessage, input)) as { content?: string; projectPath?: string; threadId?: string } | null;
      if (!value || typeof value.content !== "string" || typeof value.projectPath !== "string" || typeof value.threadId !== "string") {
        return null;
      }
      return { content: value.content, projectPath: value.projectPath, threadId: value.threadId };
    },
    claimSteeringMessages: async () => [],
    completeAssistantMessage: ({ messageId, threadId }) =>
      mt(completeAssistantMessage, { deviceToken: f.deviceToken, messageId, status: "done" as const, threadId }),
    isStopRequested: async () => false,
    recordUsage: (input) =>
      mt(recordUsage, { ...input, deviceToken: f.deviceToken }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Characterization tests — black-box, asserting at external seams
// ---------------------------------------------------------------------------

test("legacy: prompt claiming starts a turn and produces a visible assistant message", async () => {
  const f = await setupFixture();
  const threadId = await f.owner.mutation(createThread, { projectId: f.projectId, title: "char-basic" });
  await f.owner.mutation(sendUserMessage, { content: "hello", threadId });

  const gateway = makeGateway(f);
  const provider = makeEchoProvider("observed reply");

  await runQueuedTurn({
    deviceToken: f.deviceToken,
    gateway,
    governance: defaultGovernance,
    mcp: { listTools: async () => [], callTool: async () => undefined },
    platform: "linux",
    policy: defaultPolicy,
    provider,
    resolveProjectRoot: async () => f.root,
  });

  const messages = await f.owner.query(listThreadMessages, { threadId });
  const assistant = messages.filter((m) => m.role === "assistant" && m.content.length > 0);
  expect(assistant.length).toBeGreaterThanOrEqual(1);
});

test("legacy: first visible text appears in the thread after streaming", async () => {
  const f = await setupFixture();
  const threadId = await f.owner.mutation(createThread, { projectId: f.projectId, title: "char-text" });
  await f.owner.mutation(sendUserMessage, { content: "tell me something", threadId });

  const gateway = makeGateway(f);
  const provider = makeEchoProvider("streaming chunk");

  await runQueuedTurn({
    deviceToken: f.deviceToken,
    gateway,
    governance: defaultGovernance,
    mcp: { listTools: async () => [], callTool: async () => undefined },
    platform: "linux",
    policy: defaultPolicy,
    provider,
    resolveProjectRoot: async () => f.root,
  });

  const messages = await f.owner.query(listThreadMessages, { threadId });
  const textMessages = messages.filter((m) => m.content.length > 0);
  expect(textMessages.length).toBeGreaterThanOrEqual(2); // user + assistant
});

test("legacy: usage is recorded after a completed turn", async () => {
  const f = await setupFixture();
  const threadId = await f.owner.mutation(createThread, { projectId: f.projectId, title: "char-usage" });
  await f.owner.mutation(sendUserMessage, { content: "use some tokens", threadId });

  let usageRecorded = false;
  const gateway = makeGateway(f, {
    recordUsage: async (input) => {
      usageRecorded = true;
      expect(input.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(input.usage.outputTokens).toBeGreaterThanOrEqual(0);
      return f.t.mutation(recordUsage as any, { ...input, deviceToken: f.deviceToken }) as any;
    },
  });

  await runQueuedTurn({
    deviceToken: f.deviceToken,
    gateway,
    governance: defaultGovernance,
    mcp: { listTools: async () => [], callTool: async () => undefined },
    platform: "linux",
    policy: defaultPolicy,
    provider: makeEchoProvider("usage turn"),
    resolveProjectRoot: async () => f.root,
  });

  expect(usageRecorded).toBe(true);
});

test("legacy: final thread state — all messages are complete after a turn", async () => {
  const f = await setupFixture();
  const threadId = await f.owner.mutation(createThread, { projectId: f.projectId, title: "char-final" });
  await f.owner.mutation(sendUserMessage, { content: "last one", threadId });

  const gateway = makeGateway(f);

  await runQueuedTurn({
    deviceToken: f.deviceToken,
    gateway,
    governance: defaultGovernance,
    mcp: { listTools: async () => [], callTool: async () => undefined },
    platform: "linux",
    policy: defaultPolicy,
    provider: makeEchoProvider("final"),
    resolveProjectRoot: async () => f.root,
  });

  const messages = await f.owner.query(listThreadMessages, { threadId });
  const incomplete = messages.filter((m) => m.status !== "done" && m.status !== "complete");
  expect(incomplete).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Kernel mode fix: provider failure yields recoverable state (was stranded-running in legacy)
// ---------------------------------------------------------------------------

test(
  "kernel: provider failure after claim produces turn.failed and recoverable state",
  async () => {
    const { LocalHarnessRuntime } = await import("@relay/harness-runtime");
    const { MutableReactorRegistry } = await import("@relay/orchestration");

    const registry = new MutableReactorRegistry();
    registry.register("provider.send_turn", {
      execute: async (effect) => {
        if (effect.intent.kind !== "provider.send_turn") return [];
        const providerInstanceId = "provider-fail" as never;
        return [
          {
            type: "provider.event" as const,
            payload: {
              providerInstanceId,
              normalizedEvent: {
                eventId: `ev-fail-${effect.effectId}` as never,
                type: "turn.failed",
                turnId: effect.intent.turnId,
                providerInstanceId,
                correlationId: `corr-${effect.effectId}` as never,
                causationId: effect.commandId as never,
                payload: { error: "provider crash" },
              },
            },
          },
        ];
      },
      recover: async () => [],
    });

    const runtime = LocalHarnessRuntime.memory({ reactors: registry.build() });
    const snap = await runtime.createRun({ projectId: "test" });
    await runtime.resumeRun({ runId: snap.runId });
    await runtime.sendTurn({ runId: snap.runId, prompt: "crash me" });
    await runtime.drainEffects();

    const after = runtime.getSnapshotByRunId(snap.runId);
    expect(after).toBeDefined();
    // In kernel mode, the run survives provider failure.
    // The legacy mode would leave the thread permanently stranded.
    expect(after!.status).toBe("running");
  },
);
