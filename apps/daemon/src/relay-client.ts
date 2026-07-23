import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";

import { approvalResolutionSchema, queuedCommandSchema, queuedComparisonSchema, queuedMessageSchema, queuedRestoreSchema, queuedSubagentSchema, steeringMessagesSchema, stopStateSchema, type Capability, type MachineRegistration, type SubagentResult, type TokenUsage } from "@relay/shared";

const heartbeatMutation = makeFunctionReference<"mutation", { deviceToken: string }>(
  "machines:heartbeat",
);
const registerMachineMutation = makeFunctionReference<"mutation", MachineRegistration, string>(
  "machines:registerMachine",
);
const claimQueuedMessageMutation = makeFunctionReference<"mutation", { deviceToken: string }, unknown>("conversations:claimQueuedMessage");
const beginAssistantMessageMutation = makeFunctionReference<"mutation", { deviceToken: string; threadId: string }, string>("conversations:beginAssistantMessage");
const appendAssistantTextMutation = makeFunctionReference<"mutation", { content: string; deviceToken: string; messageId: string }>("conversations:appendAssistantText");
const completeAssistantMessageMutation = makeFunctionReference<"mutation", { deviceToken: string; messageId: string; resolvedCommentIds?: string[]; threadId: string; status: "done" | "failed" }>("conversations:completeAssistantMessage");
const completePlanningMutation = makeFunctionReference<"mutation", { content: string; deviceToken: string; messageId: string; threadId: string }, null>("plans:completePlanning");
const claimCommandMutation = makeFunctionReference<"mutation", { deviceToken: string }, unknown>("commands:claim");
const completeCommandMutation = makeFunctionReference<"mutation", { commandId: string; deviceToken: string; status: "complete" | "failed" }>("commands:complete");
const appendCommandOutputMutation = makeFunctionReference<"mutation", { deviceToken: string; output: string; threadId: string }>("events:appendCommandOutput");
const appendToolCompletedMutation = makeFunctionReference<"mutation", { deviceToken: string; summary: string; threadId: string; tool: string }>("events:appendToolCompleted");
const compactThreadMutation = makeFunctionReference<"mutation", { deviceToken: string; summary: string; threadId: string }, null>("conversations:compactThread");
const appendMcpTaskStatusMutation = makeFunctionReference<"mutation", { deviceToken: string; serverId: string; status: string; taskId: string; threadId: string }>("events:appendMcpTaskStatus");
const listThreadIdsQuery = makeFunctionReference<"query", { deviceToken: string }, string[]>("conversations:listThreadIds");
const snapshotDiffMutation = makeFunctionReference<"mutation", { content: string; deviceToken: string; threadId: string }>("diffs:snapshot");
const claimGitActionMutation = makeFunctionReference<"mutation", { deviceToken: string }, { action: "stage" | "commit" | "push"; actionId: string; message?: string; projectPath: string; threadId: string } | null>("git_actions:claim");
const completeGitActionMutation = makeFunctionReference<"mutation", { actionId: string; deviceToken: string; status: "complete" | "failed" }>("git_actions:complete");
const createApprovalMutation = makeFunctionReference<"mutation", { capability: "read" | "edit" | "exec" | "task" | "search"; continuationJson?: string; deviceToken: string; risk: "low" | "high" | "critical"; summary: string; threadId: string; turnId?: string }, string>("approvals:create");
const getApprovalQuery = makeFunctionReference<"query", { approvalId: string; deviceToken: string }, unknown>("approvals:getByDevice");
const kernelApprovalSchema = z.object({ continuationJson: z.string().optional(), decision: z.enum(["pending", "allow", "deny"]), threadId: z.string(), turnId: z.string().optional() });
const recordAuditMutation = makeFunctionReference<"mutation", { capability: "read" | "edit" | "exec" | "task" | "search"; decision: "allow" | "deny" | "ask"; deviceToken: string; risk: "low" | "high" | "critical"; summary: string; threadId: string }, string>("audit_log:record");
const recordUsageMutation = makeFunctionReference<"mutation", { callId: string; deviceToken: string; messageId: string; modelId: string; role: string; threadId: string; usage: TokenUsage }, string>("usage:record");
const claimSteeringMessagesMutation = makeFunctionReference<"mutation", { deviceToken: string; threadId: string }, unknown>("conversations:claimSteeringMessages");
const getStopStateQuery = makeFunctionReference<"query", { deviceToken: string; threadId: string }, unknown>("conversations:getStopState");
const acknowledgeStopMutation = makeFunctionReference<"mutation", { deviceToken: string; messageId: string; threadId: string }, null>("conversations:acknowledgeStop");
const recordCheckpointMutation = makeFunctionReference<"mutation", { commit: string; deviceToken: string; messageId: string; ref: string; threadId: string }, string>("checkpoints:record");
const claimCheckpointRestoreMutation = makeFunctionReference<"mutation", { deviceToken: string }, unknown>("checkpoints:claimRestore");
const completeCheckpointRestoreMutation = makeFunctionReference<"mutation", { actionId: string; claimToken: string; deviceToken: string; status: "complete" | "failed" }, null>("checkpoints:completeRestore");
const claimCheckpointComparisonMutation = makeFunctionReference<"mutation", { deviceToken: string }, unknown>("checkpoints:claimComparison");
const completeCheckpointComparisonMutation = makeFunctionReference<"mutation", { claimToken: string; comparisonId: string; content: string; deviceToken: string; status: "complete" | "failed" }, null>("checkpoints:completeComparison");
const seedSubagentRolesMutation = makeFunctionReference<"mutation", { deviceToken: string }, null>("subagents:seedDefaults");
const enqueueSubagentMutation = makeFunctionReference<"mutation", { capabilities: Capability[]; depth: number; deviceToken: string; parentRunId?: string; roleName: string; task: string; threadId: string }, string>("subagents:enqueueByName");
const claimSubagentMutation = makeFunctionReference<"mutation", { depth?: number; deviceToken: string }, unknown>("subagents:claim");
const completeSubagentMutation = makeFunctionReference<"mutation", { claimToken: string; deviceToken: string; result: SubagentResult; runId: string }, null>("subagents:complete");
const renewSubagentLeaseMutation = makeFunctionReference<"mutation", { claimToken: string; deviceToken: string; runId: string }, null>("subagents:renewLease");
const getSubagentResultQuery = makeFunctionReference<"query", { deviceToken: string; runId: string }, { result?: SubagentResult; status: "queued" | "running" | "complete" | "failed"; threadId: string }>("subagents:getResult");
const setCapabilityCeilingMutation = makeFunctionReference<"mutation", { capabilities: Capability[]; deviceToken: string }, null>("machines:setCapabilityCeiling");
const listPendingProjectsQuery = makeFunctionReference<"query", { deviceToken: string }, Array<{ id: string; name: string; path: string }>>("projects:listPending");
const resolvePendingProjectMutation = makeFunctionReference<"mutation", { deviceToken: string; projectId: string; ok: boolean; error?: string }, null>("projects:resolvePending");
const requestTrustMutation = makeFunctionReference<"mutation", { deviceToken: string; projectId: string }, null>("projects:requestTrust");
const getProjectQuery = makeFunctionReference<"query", { deviceToken: string; projectId: string }, { trustState?: "requested" | "trusted" | "untrusted" } | null>("projects:get");
const publishCommandCatalogMutation = makeFunctionReference<"mutation", { commands: Array<{ argumentHint?: string; description: string; name: string; projectPath?: string; scope: "builtin" | "project" | "user" | "skill" }>; deviceToken: string }, null>("slash_commands:publishCatalog");
const updateTodosMutation = makeFunctionReference<"mutation", { deviceToken: string; items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>; threadId: string }, null>("todos:update");
const listMcpServersQuery = makeFunctionReference<"query", { deviceToken: string }, unknown[]>("mcp_servers:listForDaemon");
const reportMcpStatusMutation = makeFunctionReference<"mutation", { authorizationUrl?: string; deviceToken: string; error?: string; serverId: string; status: "connecting" | "authorizing" | "connected" | "error"; toolCount: number }, null>("mcp_servers:reportStatus");
const createMcpElicitationMutation = makeFunctionReference<"mutation", { deviceToken: string; promptsJson: string; serverId: string; threadId: string; toolName: string }, string>("mcp_elicitations:create");
const getMcpElicitationQuery = makeFunctionReference<"query", { deviceToken: string; elicitationId: string }, { responseJson?: string; status: "pending" | "submitted" | "cancelled" } | null>("mcp_elicitations:get");

export interface MachineGateway {
  heartbeat(input: { deviceToken: string }): Promise<unknown>;
  registerMachine(registration: MachineRegistration): Promise<string>;
}

export class MachineReporter {
  readonly #gateway: MachineGateway;
  readonly #registration: MachineRegistration;
  #lastSyncedProjects: string | null = null;
  #machineId: string | undefined;

  constructor({ gateway, registration }: { gateway: MachineGateway; registration: MachineRegistration }) {
    this.#gateway = gateway;
    this.#registration = registration;
  }

  /** The Convex machine document ID, available after `connect()` resolves. */
  get machineId(): string {
    if (!this.#machineId) throw new Error("MachineReporter.machineId read before connect() resolved");
    return this.#machineId;
  }

  async connect(): Promise<string> {
    this.#machineId = await this.#gateway.registerMachine(this.#registration);
    return this.#machineId;
  }

  heartbeatOnce(): Promise<unknown> {
    return this.#gateway.heartbeat({ deviceToken: this.#registration.deviceToken });
  }

  async syncProjects(projects: import("@relay/shared").ProjectRegistration[]): Promise<void> {
    const serialized = JSON.stringify(projects);
    if (serialized === this.#lastSyncedProjects) return;
    const registration = { ...this.#registration, projects };
    await this.#gateway.registerMachine(registration);
    this.#lastSyncedProjects = serialized;
  }
}

export function createConvexMachineGateway({ deploymentUrl }: { deploymentUrl: string }): MachineGateway {
  const client = new ConvexHttpClient(deploymentUrl);

  return {
    heartbeat: ({ deviceToken }) => client.mutation(heartbeatMutation, { deviceToken }),
    registerMachine: (registration) => client.mutation(registerMachineMutation, registration),
  };
}

export function createConvexConversationGateway({ deploymentUrl, deviceToken }: { deploymentUrl: string; deviceToken: string }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    acknowledgeStop: (input: { deviceToken: string; messageId: string; threadId: string }) => client.mutation(acknowledgeStopMutation, input),
    appendAssistantText: ({ content, messageId }: { content: string; messageId: string }) => client.mutation(appendAssistantTextMutation, { content, deviceToken, messageId }),
    beginAssistantMessage: ({ threadId }: { threadId: string }) => client.mutation(beginAssistantMessageMutation, { deviceToken, threadId }),
    claimQueuedMessage: async ({ deviceToken }: { deviceToken: string }) => queuedMessageSchema.nullable().parse(await client.mutation(claimQueuedMessageMutation, { deviceToken })),
    claimSteeringMessages: async (input: { deviceToken: string; threadId: string }) => steeringMessagesSchema.parse(await client.mutation(claimSteeringMessagesMutation, input)),
    completeAssistantMessage: ({ messageId, resolvedCommentIds, status = "done", threadId }: { messageId: string; resolvedCommentIds?: string[]; status?: "done" | "failed"; threadId: string }) => client.mutation(completeAssistantMessageMutation, { deviceToken, messageId, resolvedCommentIds, status, threadId }),
    completePlanning: (input: { content: string; messageId: string; threadId: string }) => client.mutation(completePlanningMutation, { ...input, deviceToken }),
    enqueueSubagent: (input: { capabilities: Capability[]; depth: number; deviceToken: string; roleName: string; task: string; threadId: string }) => client.mutation(enqueueSubagentMutation, input),
    recordToolCompleted: (input: { summary: string; threadId: string; tool: string }) => client.mutation(appendToolCompletedMutation, { ...input, deviceToken }),
    compactThread: (input: { summary: string; threadId: string }) => client.mutation(compactThreadMutation, { ...input, deviceToken }),
    listThreadIds: () => client.query(listThreadIdsQuery, { deviceToken }),
    isStopRequested: async (input: { deviceToken: string; threadId: string }) => stopStateSchema.parse(await client.query(getStopStateQuery, input)).requested,
    recordCheckpoint: (input: { commit: string; deviceToken: string; messageId: string; ref: string; threadId: string }) => client.mutation(recordCheckpointMutation, input),
    recordMcpTaskStatus: (input: { serverId: string; status: string; taskId: string; threadId: string }) => client.mutation(appendMcpTaskStatusMutation, { ...input, deviceToken }),
    requestMcpInput: async (input: { prompts: unknown[]; serverId: string; threadId: string; toolName: string }) => {
      const elicitationId = await client.mutation(createMcpElicitationMutation, { deviceToken, promptsJson: JSON.stringify(input.prompts), serverId: input.serverId, threadId: input.threadId, toolName: input.toolName });
      for (;;) {
        const elicitation = await client.query(getMcpElicitationQuery, { deviceToken, elicitationId });
        if (elicitation?.status === "submitted" && elicitation.responseJson) {
          const response: unknown = JSON.parse(elicitation.responseJson);
          if (typeof response !== "object" || response === null || Array.isArray(response)) throw new Error("Invalid MCP elicitation response");
          return Object.fromEntries(Object.entries(response));
        }
        if (elicitation?.status === "cancelled") throw new Error("MCP elicitation was cancelled");
        await Bun.sleep(200);
      }
    },
    requestTrust: (projectId: string) => client.mutation(requestTrustMutation, { deviceToken, projectId }).then(() => undefined),
    publishCommandCatalog: (commands: Array<{ argumentHint?: string; description: string; name: string; projectPath?: string; scope: "builtin" | "project" | "user" | "skill" }>) => client.mutation(publishCommandCatalogMutation, { commands, deviceToken }).then(() => undefined),
    updateTodos: (input: { items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>; threadId: string }) => client.mutation(updateTodosMutation, { ...input, deviceToken }).then(() => undefined),
    recordUsage: (input: { callId: string; messageId: string; modelId: string; role: string; threadId: string; usage: TokenUsage }) => client.mutation(recordUsageMutation, { ...input, deviceToken }),
    snapshotDiff: (input: { content: string; threadId: string }) => client.mutation(snapshotDiffMutation, { ...input, deviceToken }),
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

export function createConvexMcpServerGateway({ deploymentUrl, deviceToken }: { deploymentUrl: string; deviceToken: string }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    listServers: () => client.query(listMcpServersQuery, { deviceToken }),
    reportStatus: (input: { authorizationUrl?: string; error?: string; serverId: string; status: "connecting" | "authorizing" | "connected" | "error"; toolCount: number }) => client.mutation(reportMcpStatusMutation, { ...input, deviceToken }),
  };
}

export function createConvexSubagentGateway({ deploymentUrl, deviceToken, depth }: { deploymentUrl: string; deviceToken: string; depth?: number }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    claim: async () => queuedSubagentSchema.nullable().parse(await client.mutation(claimSubagentMutation, { depth, deviceToken })),
    complete: (input: { claimToken: string; result: SubagentResult; runId: string }) => client.mutation(completeSubagentMutation, { ...input, deviceToken }),
    enqueue: (input: { capabilities: Capability[]; depth: number; parentRunId: string; roleName: string; task: string; threadId: string }) => client.mutation(enqueueSubagentMutation, { ...input, deviceToken }),
    renew: (input: { claimToken: string; runId: string }) => client.mutation(renewSubagentLeaseMutation, { ...input, deviceToken }),
    seedDefaults: () => client.mutation(seedSubagentRolesMutation, { deviceToken }),
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
    snapshotDiff: (input: { content: string; threadId: string }) => client.mutation(snapshotDiffMutation, { ...input, deviceToken }),
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
    complete: (input: { actionId: string; status: "complete" | "failed" }) => client.mutation(completeGitActionMutation, { ...input, deviceToken }),
  };
}

export function createConvexGovernanceGateway({ deploymentUrl, deviceToken }: { deploymentUrl: string; deviceToken: string }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    recordDecision: (input: { capability: "read" | "edit" | "exec" | "task" | "search"; decision: "allow" | "deny"; risk: "low" | "high" | "critical"; summary: string; threadId: string }) => client.mutation(recordAuditMutation, { ...input, deviceToken }),
    requestApproval: async (input: { capability: "read" | "edit" | "exec" | "task" | "search"; risk: "low" | "high" | "critical"; summary: string; threadId: string }) => {
      const approvalId = await client.mutation(createApprovalMutation, { ...input, deviceToken });
      for (;;) {
        const approval = approvalResolutionSchema.nullable().parse(await client.query(getApprovalQuery, { approvalId, deviceToken }));
        if (approval?.decision === "allow" || approval?.decision === "deny") return approval.decision;
        await Bun.sleep(200);
      }
    },
    createApproval: (input: { capability: "read" | "edit" | "exec" | "task" | "search"; continuationJson: string; risk: "low" | "high" | "critical"; summary: string; threadId: string; turnId: string }) => client.mutation(createApprovalMutation, { ...input, deviceToken }),
    getApproval: async ({ approvalId }: { approvalId: string }) => {
      const approval = await client.query(getApprovalQuery, { approvalId, deviceToken });
      return approval === null ? null : kernelApprovalSchema.parse(approval);
    },
  };
}

export function createConvexCommandGateway({ deploymentUrl, deviceToken }: { deploymentUrl: string; deviceToken: string }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    appendOutput: (input: { output: string; threadId: string }) => client.mutation(appendCommandOutputMutation, { ...input, deviceToken }),
    claim: async () => queuedCommandSchema.nullable().parse(await client.mutation(claimCommandMutation, { deviceToken })),
    complete: (input: { commandId: string; status: "complete" | "failed" }) => client.mutation(completeCommandMutation, { ...input, deviceToken }),
  };
}

export function createConvexProjectRequestGateway({ deploymentUrl, deviceToken }: { deploymentUrl: string; deviceToken: string }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    listPending: () => client.query(listPendingProjectsQuery, { deviceToken }),
    resolvePending: (input: { projectId: string; ok: boolean; error?: string }) => client.mutation(resolvePendingProjectMutation, { ...input, deviceToken }),
    requestTrust: (projectId: string) => client.mutation(requestTrustMutation, { deviceToken, projectId }).then(() => undefined),
    getTrustState: async (projectId: string) => {
      const project = await client.query(getProjectQuery, { deviceToken, projectId });
      return project?.trustState;
    },
  };
}
