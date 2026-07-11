import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import type { MachineRegistration } from "@relay/shared";

const heartbeatMutation = makeFunctionReference<"mutation", { deviceToken: string }>(
  "machines:heartbeat",
);
const registerMachineMutation = makeFunctionReference<"mutation", MachineRegistration>(
  "machines:registerMachine",
);
const claimQueuedMessageMutation = makeFunctionReference<"mutation", { deviceToken: string }, { content: string; projectPath: string; threadId: string } | null>("conversations:claimQueuedMessage");
const beginAssistantMessageMutation = makeFunctionReference<"mutation", { threadId: string }, string>("conversations:beginAssistantMessage");
const appendAssistantTextMutation = makeFunctionReference<"mutation", { content: string; messageId: string }>("conversations:appendAssistantText");
const completeAssistantMessageMutation = makeFunctionReference<"mutation", { messageId: string; threadId: string; status: "done" }>("conversations:completeAssistantMessage");
const claimCommandMutation = makeFunctionReference<"mutation", Record<string, never>, { command: string; commandId: string; projectPath: string; threadId: string } | null>("commands:claim");
const completeCommandMutation = makeFunctionReference<"mutation", { commandId: string; status: "complete" | "failed" }>("commands:complete");
const appendCommandOutputMutation = makeFunctionReference<"mutation", { output: string; threadId: string }>("events:appendCommandOutput");
const appendToolCompletedMutation = makeFunctionReference<"mutation", { summary: string; threadId: string; tool: "bash" | "edit" | "read" }>("events:appendToolCompleted");
const listThreadIdsQuery = makeFunctionReference<"query", Record<string, never>, string[]>("conversations:listThreadIds");
const snapshotDiffMutation = makeFunctionReference<"mutation", { content: string; threadId: string }>("diffs:snapshot");
const claimGitActionMutation = makeFunctionReference<"mutation", { deviceToken: string }, { action: "stage" | "commit" | "push"; actionId: string; message?: string; projectPath: string; threadId: string } | null>("git_actions:claim");
const completeGitActionMutation = makeFunctionReference<"mutation", { actionId: string; status: "complete" | "failed" }>("git_actions:complete");

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
    appendAssistantText: ({ content, messageId }: { content: string; messageId: string }) => client.mutation(appendAssistantTextMutation, { content, messageId }),
    beginAssistantMessage: ({ threadId }: { threadId: string }) => client.mutation(beginAssistantMessageMutation, { threadId }),
    claimQueuedMessage: ({ deviceToken }: { deviceToken: string }) => client.mutation(claimQueuedMessageMutation, { deviceToken }),
    completeAssistantMessage: ({ messageId, threadId }: { messageId: string; threadId: string }) => client.mutation(completeAssistantMessageMutation, { messageId, status: "done", threadId }),
    recordToolCompleted: (input: { summary: string; threadId: string; tool: "bash" | "edit" | "read" }) => client.mutation(appendToolCompletedMutation, input),
    listThreadIds: () => client.query(listThreadIdsQuery, {}),
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

export function createConvexCommandGateway({ deploymentUrl }: { deploymentUrl: string }) {
  const client = new ConvexHttpClient(deploymentUrl);
  return {
    appendOutput: (input: { output: string; threadId: string }) => client.mutation(appendCommandOutputMutation, input),
    claim: () => client.mutation(claimCommandMutation, {}),
    complete: (input: { commandId: string; status: "complete" | "failed" }) => client.mutation(completeCommandMutation, input),
  };
}
