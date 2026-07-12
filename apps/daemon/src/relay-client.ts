import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { approvalResolutionSchema, queuedCommandSchema, queuedMessageSchema, steeringMessagesSchema, stopStateSchema, type MachineRegistration, type TokenUsage } from "@relay/shared";

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
const claimCommandMutation = makeFunctionReference<"mutation", { deviceToken: string }, unknown>("commands:claim");
const completeCommandMutation = makeFunctionReference<"mutation", { commandId: string; status: "complete" | "failed" }>("commands:complete");
const appendCommandOutputMutation = makeFunctionReference<"mutation", { output: string; threadId: string }>("events:appendCommandOutput");
const appendToolCompletedMutation = makeFunctionReference<"mutation", { summary: string; threadId: string; tool: "bash" | "edit" | "read" }>("events:appendToolCompleted");
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
    recordToolCompleted: (input: { summary: string; threadId: string; tool: "bash" | "edit" | "read" }) => client.mutation(appendToolCompletedMutation, input),
    listThreadIds: () => client.query(listThreadIdsQuery, {}),
    isStopRequested: async (input: { deviceToken: string; threadId: string }) => stopStateSchema.parse(await client.query(getStopStateQuery, input)).requested,
    recordUsage: (input: { callId: string; messageId: string; modelId: string; role: string; threadId: string; usage: TokenUsage }) => client.mutation(recordUsageMutation, input),
    snapshotDiff: (input: { content: string; threadId: string }) => client.mutation(snapshotDiffMutation, input),
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
