import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { approvalResolutionSchema, queuedCommandSchema, queuedComparisonSchema, queuedMessageSchema, queuedRestoreSchema, queuedSubagentSchema, steeringMessagesSchema, stopStateSchema, type Capability, type MachineRegistration, type SubagentResult, type TokenUsage } from "@relay/shared";

const heartbeatMutation = makeFunctionReference<"mutation", { deviceToken: string }>(
  "machines:heartbeat",
);
const registerMachineMutation = makeFunctionReference<"mutation", MachineRegistration>(
  "machines:registerMachine",
);
const claimQueuedMessageMutation = makeFunctionReference<"mutation", { deviceToken: string }, unknown>("conversations:claimQueuedMessage");
const beginAssistantMessageMutation = makeFunctionReference<"mutation", { threadId: string }, string>("conversations:beginAssistantMessage");
const appendAssistantTextMutation = makeFunctionReference<"mutation", { content: string; messageId: string }>("conversations:appendAssistantText");
const completeAssistantMessageMutation = makeFunctionReference<"mutation", { messageId: string; resolvedCommentIds?: string[]; threadId: string; status: "done" }>("conversations:completeAssistantMessage");
const completePlanningMutation = makeFunctionReference<"mutation", { content: string; messageId: string; threadId: string }, null>("plans:completePlanning");
const claimCommandMutation = makeFunctionReference<"mutation", { deviceToken: string }, unknown>("commands:claim");
const completeCommandMutation = makeFunctionReference<"mutation", { commandId: string; status: "complete" | "failed" }>("commands:complete");
const appendCommandOutputMutation = makeFunctionReference<"mutation", { output: string; threadId: string }>("events:appendCommandOutput");
const appendToolCompletedMutation = makeFunctionReference<"mutation", { summary: string; threadId: string; tool: "bash" | "edit" | "read" | "task" }>("events:appendToolCompleted");
const listThreadIdsQuery = makeFunctionReference<"query", Record<string, never>, string[]>("conversations:listThreadIds");
const snapshotDiffMutation = makeFunctionReference<"mutation", { content: string; threadId: string }>("diffs:snapshot");
const claimGitActionMutation = makeFunctionReference<"mutation", { deviceToken: string }, { action: "stage" | "commit" | "push"; actionId: string; message?: string; projectPath: string; threadId: string } | null>("git_actions:claim");
const completeGitActionMutation = makeFunctionReference<"mutation", { actionId: string; status: "complete" | "failed" }>("git_actions:complete");
const createApprovalMutation = makeFunctionReference<"mutation", { capability: "read" | "edit" | "exec" | "task"; risk: "low" | "high" | "critical"; summary: string; threadId: string }, string>("approvals:create");
const getApprovalQuery = makeFunctionReference<"query", { approvalId: string }, unknown>("approvals:get");
const recordAuditMutation = makeFunctionReference<"mutation", { capability: "read" | "edit" | "exec" | "task"; decision: "allow" | "deny" | "ask"; risk: "low" | "high" | "critical"; summary: string; threadId: string }, string>("audit_log:record");
const recordUsageMutation = makeFunctionReference<"mutation", { callId: string; messageId: string; modelId: string; role: string; threadId: string; usage: TokenUsage }, string>("usage:record");
const claimSteeringMessagesMutation = makeFunctionReference<"mutation", { deviceToken: string; threadId: string }, unknown>("conversations:claimSteeringMessages");
const getStopStateQuery = makeFunctionReference<"query", { deviceToken: string; threadId: string }, unknown>("conversations:getStopState");
const acknowledgeStopMutation = makeFunctionReference<"mutation", { deviceToken: string; messageId: string; threadId: string }, null>("conversations:acknowledgeStop");
const recordCheckpointMutation = makeFunctionReference<"mutation", { commit: string; deviceToken: string; messageId: string; ref: string; threadId: string }, string>("checkpoints:record");
const claimCheckpointRestoreMutation = makeFunctionReference<"mutation", { deviceToken: string }, unknown>("checkpoints:claimRestore");
const completeCheckpointRestoreMutation = makeFunctionReference<"mutation", { actionId: string; claimToken: string; deviceToken: string; status: "complete" | "failed" }, null>("checkpoints:completeRestore");
const claimCheckpointComparisonMutation = makeFunctionReference<"mutation", { deviceToken: string }, unknown>("checkpoints:claimComparison");
const completeCheckpointComparisonMutation = makeFunctionReference<"mutation", { claimToken: string; comparisonId: string; content: string; deviceToken: string; status: "complete" | "failed" }, null>("checkpoints:completeComparison");
const seedSubagentRolesMutation = makeFunctionReference<"mutation", Record<string, never>, null>("subagents:seedDefaults");
const enqueueSubagentMutation = makeFunctionReference<"mutation", { capabilities: Capability[]; depth: number; deviceToken: string; parentRunId?: string; roleName: string; task: string; threadId: string }, string>("subagents:enqueueByName");
const claimSubagentMutation = makeFunctionReference<"mutation", { depth?: number; deviceToken: string }, unknown>("subagents:claim");
const completeSubagentMutation = makeFunctionReference<"mutation", { claimToken: string; deviceToken: string; result: SubagentResult; runId: string }, null>("subagents:complete");
const renewSubagentLeaseMutation = makeFunctionReference<"mutation", { claimToken: string; deviceToken: string; runId: string }, null>("subagents:renewLease");
const getSubagentResultQuery = makeFunctionReference<"query", { deviceToken: string; runId: string }, { result?: SubagentResult; status: "queued" | "running" | "complete" | "failed"; threadId: string }>("subagents:getResult");
const setCapabilityCeilingMutation = makeFunctionReference<"mutation", { capabilities: Capability[]; deviceToken: string }, null>("machines:setCapabilityCeiling");

export interface MachineGateway {
  heartbeat(input: { deviceToken: string }): Promise<unknown>;
  registerMachine(registration: MachineRegistration): Promise<unknown>;
}

export class MachineReporter {
  readonly #gateway: MachineGateway;
  readonly #registration: MachineRegistration;

  constructor({ gateway, registration }: { gateway: MachineGateway; registration: MachineRegistration }) {
    this.#gateway = gateway;
    this.#registration = registration;
  }

  connect(): Promise<unknown> {
    return this.#gateway.registerMachine(this.#registration);
  }

  heartbeatOnce(): Promise<unknown> {
    return this.#gateway.heartbeat({ deviceToken: this.#registration.deviceToken });
  }
}

export function createConvexMachineGateway({ deploymentUrl }: { deploymentUrl: string }): MachineGateway {
  const client = new ConvexHttpClient(deploymentUrl);

  return {
    heartbeat: ({ deviceToken }) => client.mutation(heartbeatMutation, { deviceToken }),
    registerMachine: (registration) => client.mutation(registerMachineMutation, registration),
  };
}

export function createConvexConversationGateway({ deploymentUrl }: { deploymentUrl: string }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    acknowledgeStop: (input: { deviceToken: string; messageId: string; threadId: string }) => client.mutation(acknowledgeStopMutation, input),
    appendAssistantText: ({ content, messageId }: { content: string; messageId: string }) => client.mutation(appendAssistantTextMutation, { content, messageId }),
    beginAssistantMessage: ({ threadId }: { threadId: string }) => client.mutation(beginAssistantMessageMutation, { threadId }),
    claimQueuedMessage: async ({ deviceToken }: { deviceToken: string }) => queuedMessageSchema.nullable().parse(await client.mutation(claimQueuedMessageMutation, { deviceToken })),
    claimSteeringMessages: async (input: { deviceToken: string; threadId: string }) => steeringMessagesSchema.parse(await client.mutation(claimSteeringMessagesMutation, input)),
    completeAssistantMessage: ({ messageId, resolvedCommentIds, threadId }: { messageId: string; resolvedCommentIds?: string[]; threadId: string }) => client.mutation(completeAssistantMessageMutation, { messageId, resolvedCommentIds, status: "done", threadId }),
    completePlanning: (input: { content: string; messageId: string; threadId: string }) => client.mutation(completePlanningMutation, input),
    enqueueSubagent: (input: { capabilities: Capability[]; depth: number; deviceToken: string; roleName: string; task: string; threadId: string }) => client.mutation(enqueueSubagentMutation, input),
    recordToolCompleted: (input: { summary: string; threadId: string; tool: "bash" | "edit" | "read" | "task" }) => client.mutation(appendToolCompletedMutation, input),
    listThreadIds: () => client.query(listThreadIdsQuery, {}),
    isStopRequested: async (input: { deviceToken: string; threadId: string }) => stopStateSchema.parse(await client.query(getStopStateQuery, input)).requested,
    recordCheckpoint: (input: { commit: string; deviceToken: string; messageId: string; ref: string; threadId: string }) => client.mutation(recordCheckpointMutation, input),
    recordUsage: (input: { callId: string; messageId: string; modelId: string; role: string; threadId: string; usage: TokenUsage }) => client.mutation(recordUsageMutation, input),
    snapshotDiff: (input: { content: string; threadId: string }) => client.mutation(snapshotDiffMutation, input),
    waitForSubagent: async ({ deviceToken, runId, threadId }: { deviceToken: string; runId: string; threadId: string }) => {
      for (;;) {
        if (stopStateSchema.parse(await client.query(getStopStateQuery, { deviceToken, threadId })).requested) return { artifacts: [], findings: [], status: "failed" as const, summary: "Parent turn stopped while waiting for subagent." };
        const state = await client.query(getSubagentResultQuery, { deviceToken, runId });
        if ((state.status === "complete" || state.status === "failed") && state.result) return state.result;
        await Bun.sleep(200);
      }
    },
  };
}

export function createConvexSubagentGateway({ deploymentUrl, deviceToken, depth }: { deploymentUrl: string; deviceToken: string; depth?: number }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    claim: async () => queuedSubagentSchema.nullable().parse(await client.mutation(claimSubagentMutation, { depth, deviceToken })),
    complete: (input: { claimToken: string; result: SubagentResult; runId: string }) => client.mutation(completeSubagentMutation, { ...input, deviceToken }),
    enqueue: (input: { capabilities: Capability[]; depth: number; parentRunId: string; roleName: string; task: string; threadId: string }) => client.mutation(enqueueSubagentMutation, { ...input, deviceToken }),
    renew: (input: { claimToken: string; runId: string }) => client.mutation(renewSubagentLeaseMutation, { ...input, deviceToken }),
    seedDefaults: () => client.mutation(seedSubagentRolesMutation, {}),
    setCapabilityCeiling: (capabilities: Capability[]) => client.mutation(setCapabilityCeilingMutation, { capabilities, deviceToken }),
    wait: async ({ runId }: { runId: string }) => {
      for (;;) {
        const state = await client.query(getSubagentResultQuery, { deviceToken, runId });
        if ((state.status === "complete" || state.status === "failed") && state.result) return state.result;
        await Bun.sleep(200);
      }
    },
  };
}

export function createConvexCheckpointGateway({ deploymentUrl, deviceToken }: { deploymentUrl: string; deviceToken: string }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    claim: async () => queuedRestoreSchema.nullable().parse(await client.mutation(claimCheckpointRestoreMutation, { deviceToken })),
    complete: (input: { actionId: string; claimToken: string; status: "complete" | "failed" }) => client.mutation(completeCheckpointRestoreMutation, { ...input, deviceToken }),
    snapshotDiff: (input: { content: string; threadId: string }) => client.mutation(snapshotDiffMutation, input),
  };
}

export function createConvexCheckpointComparisonGateway({ deploymentUrl, deviceToken }: { deploymentUrl: string; deviceToken: string }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    claim: async () => queuedComparisonSchema.nullable().parse(await client.mutation(claimCheckpointComparisonMutation, { deviceToken })),
    complete: (input: { claimToken: string; comparisonId: string; content: string; status: "complete" | "failed" }) => client.mutation(completeCheckpointComparisonMutation, { ...input, deviceToken }),
  };
}

export function createConvexGitGateway({ deploymentUrl, deviceToken }: { deploymentUrl: string; deviceToken: string }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    claim: () => client.mutation(claimGitActionMutation, { deviceToken }),
    complete: (input: { actionId: string; status: "complete" | "failed" }) => client.mutation(completeGitActionMutation, input),
  };
}

export function createConvexGovernanceGateway({ deploymentUrl }: { deploymentUrl: string }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    recordDecision: (input: { capability: "read" | "edit" | "exec" | "task"; decision: "allow" | "deny"; risk: "low" | "high" | "critical"; summary: string; threadId: string }) => client.mutation(recordAuditMutation, input),
    requestApproval: async (input: { capability: "read" | "edit" | "exec" | "task"; risk: "low" | "high" | "critical"; summary: string; threadId: string }) => {
      const approvalId = await client.mutation(createApprovalMutation, input);
      for (;;) {
        const approval = approvalResolutionSchema.nullable().parse(await client.query(getApprovalQuery, { approvalId }));
        if (approval?.decision === "allow" || approval?.decision === "deny") return approval.decision;
        await Bun.sleep(200);
      }
    },
  };
}

export function createConvexCommandGateway({ deploymentUrl, deviceToken }: { deploymentUrl: string; deviceToken: string }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    appendOutput: (input: { output: string; threadId: string }) => client.mutation(appendCommandOutputMutation, input),
    claim: async () => queuedCommandSchema.nullable().parse(await client.mutation(claimCommandMutation, { deviceToken })),
    complete: (input: { commandId: string; status: "complete" | "failed" }) => client.mutation(completeCommandMutation, input),
  };
}
