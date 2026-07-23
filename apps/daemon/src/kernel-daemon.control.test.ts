import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KernelDaemon } from "./kernel-daemon";
import type { ModelProviderRouter, ModelProvider } from "./model-provider";
import type { TurnModelProvider, TurnStreamEvent } from "./turn-loop";
import { runCommand } from "./tools";

test("canary invariant violation persists a redacted marker and stops the kernel", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-kernel-canary-daemon-"));
  let rollback: { reason: string; mode: string } | undefined;
  const daemon = new KernelDaemon({
    commandGateway: {
      submitCommand: async () => "inbox-id",
      claimBatch: async () => [],
      completeCommand: async () => undefined,
      renewLease: async () => undefined,
    },
    daemonHome,
    deploymentUrl: "http://unused",
    deviceToken: "device",
    heartbeatIntervalMs: 60_000,
    machineId: "machine",
    machineName: "canary-test",
    onCanaryRollback: async ({ reason, telemetry }) => { rollback = { mode: telemetry.mode, reason }; },
    pollIntervalMs: 60_000,
    projectionSink: {
      appendEvents: async () => undefined,
      upsertSnapshot: async () => undefined,
      advanceCursor: async () => undefined,
    },
    rollbackThresholds: { maxProjectionDivergences: 0, maxProjectionGaps: -1, maxSandboxViolations: 0, maxUnrecoverableFailures: 0 },
  });

  try {
    await daemon.start();
    await daemon.heartbeatOnce();
    expect(rollback).toEqual({ mode: "kernel", reason: "projection-gap" });
    const marker = JSON.parse(await readFile(join(daemonHome, "kernel-canary-rollback.json"), "utf8")) as { reason: string; telemetry: { mode: string } };
    expect(marker).toMatchObject({ reason: "projection-gap", telemetry: { mode: "kernel" } });
  } finally {
    await daemon.stop();
    await rm(daemonHome, { force: true, recursive: true });
  }
});

class BlockingTurnProvider implements TurnModelProvider {
  readonly modelId = "control-test";
  started!: () => void;
  aborted = false;
  #release!: () => void;
  #gate = new Promise<void>((resolve) => { this.#release = resolve; });

  release(): void { this.#release(); }

  async *streamTurn({ signal }: { messages: never[]; signal: AbortSignal; system: string; tools: never[] }): AsyncIterable<TurnStreamEvent> {
    this.started();
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const onAbort = () => { this.aborted = true; resolve(); };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#gate.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
    if (signal.aborted) return;
    yield { kind: "text", text: "completed" };
    yield { kind: "stop", reason: "end_turn" };
  }
}

test("daemon routes interrupt to an in-flight kernel provider", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-kernel-control-daemon-"));
  const runId = "run-control-daemon";
  const pending = [
    command("inbox-create", "run.create", runId, { projectId: "project-control" }),
    command("inbox-resume", "run.resume", runId, {}),
  ];
  const completed: string[] = [];
  const provider = new BlockingTurnProvider();
  const started = new Promise<void>((resolve) => { provider.started = resolve; });
  const router: ModelProviderRouter = {
    kind: "model-router",
    resolve: () => ({
      modelId: "control-test",
      async *streamReply() {},
    } satisfies ModelProvider),
    resolveTurn: () => provider,
  };
  const commandGateway = {
    submitCommand: async () => "inbox-id",
    claimBatch: async () => pending.splice(0, 5),
    completeCommand: async ({ commandId }: { commandId: string }) => { completed.push(commandId); },
    renewLease: async () => undefined,
  };
  const projectionSink = {
    appendEvents: async () => undefined,
    upsertSnapshot: async () => undefined,
    advanceCursor: async () => undefined,
  };
  const daemon = new KernelDaemon({
    commandGateway,
    daemonHome,
    deploymentUrl: "http://unused",
    deviceToken: "device",
    heartbeatIntervalMs: 60_000,
    machineId: "machine",
    machineName: "control-test",
    pollIntervalMs: 60_000,
    projectionSink,
    providerRouter: router,
  });

  try {
    await daemon.start();
    await daemon.pollOnce();
    pending.push(command("inbox-send", "turn.send", runId, { prompt: "wait" }));
    await daemon.pollOnce();
    await started;
    pending.push(command("inbox-interrupt", "turn.interrupt", runId, { reason: "user" }));
    await daemon.pollOnce();
    const deadline = Date.now() + 2_000;
    while (!provider.aborted && Date.now() < deadline) await Bun.sleep(10);
    expect(provider.aborted).toBe(true);
    expect(completed).toContain("inbox-interrupt");
  } finally {
    provider.release();
    await daemon.stop();
    await rm(daemonHome, { force: true, recursive: true });
  }
});

test("daemon captures idempotent before and after checkpoints around a turn", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-kernel-checkpoint-daemon-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "relay-kernel-checkpoint-project-"));
  const runId = "run-checkpoint-daemon";
  const pending = [
    command("inbox-create-checkpoint", "run.create", runId, { projectId: "project-checkpoint" }),
    command("inbox-resume-checkpoint", "run.resume", runId, {}),
  ];
  const projected: Array<{ eventId: string; type: string }> = [];
  const provider: TurnModelProvider = {
    modelId: "checkpoint-test",
    async *streamTurn() {
      yield { kind: "text", text: "done" };
      yield { kind: "stop", reason: "end_turn" };
    },
  };
  const router: ModelProviderRouter = {
    kind: "model-router",
    resolve: () => ({ modelId: "checkpoint-test", async *streamReply() {} } satisfies ModelProvider),
    resolveTurn: () => provider,
  };
  const daemon = new KernelDaemon({
    adapterDeps: { platform: "linux", resolveProjectRoot: async () => projectRoot },
    commandGateway: {
      submitCommand: async () => "inbox-id",
      claimBatch: async () => pending.splice(0, 5),
      completeCommand: async () => undefined,
      renewLease: async () => undefined,
    },
    daemonHome,
    deploymentUrl: "http://unused",
    deviceToken: "device",
    heartbeatIntervalMs: 60_000,
    machineId: "machine",
    machineName: "checkpoint-test",
    pollIntervalMs: 60_000,
    projectionSink: {
      appendEvents: async ({ events }) => { projected.push(...events.map((event) => ({ eventId: event.eventId, type: event.type }))); },
      upsertSnapshot: async () => undefined,
      advanceCursor: async () => undefined,
    },
    providerRouter: router,
  });

  try {
    await runCommand({ command: "git init && git config user.email relay@example.test && git config user.name Relay && git commit --allow-empty -m baseline", platform: "linux", root: projectRoot });
    await daemon.start();
    await daemon.pollOnce();
    pending.push(command("inbox-send-checkpoint", "turn.send", runId, { projectPath: projectRoot, prompt: "checkpoint" }));
    await daemon.pollOnce();
    const deadline = Date.now() + 2_000;
    while (projected.filter((event) => event.type === "checkpoint.captured").length < 2 && Date.now() < deadline) {
      await daemon.flushOnce();
      await Bun.sleep(10);
    }
    expect(projected.filter((event) => event.type === "checkpoint.captured")).toHaveLength(2);
    expect(new Set(projected.filter((event) => event.type === "checkpoint.captured").map((event) => event.eventId)).size).toBe(2);
  } finally {
    await daemon.stop();
    await rm(daemonHome, { force: true, recursive: true });
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("kernel provider task calls execute through the governed subagent adapter", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-kernel-task-daemon-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "relay-kernel-task-project-"));
  const runId = "run-task-daemon";
  const pending = [
    command("inbox-create-task", "run.create", runId, { projectId: "project-task" }),
    command("inbox-resume-task", "run.resume", runId, {}),
  ];
  const projected: Array<{ payloadJson: string; type: string }> = [];
  let turnCalls = 0;
  const turnProvider: TurnModelProvider = {
    modelId: "task-test",
    async *streamTurn() {
      if (turnCalls++ === 0) {
        yield { kind: "tool_use", call: { capabilities: ["read"], kind: "task", role: "explore", task: "inspect the repository" }, id: "task-1" };
        yield { kind: "stop", reason: "tool_use" };
        return;
      }
      yield { kind: "text", text: "Subagent finished." };
      yield { kind: "stop", reason: "end_turn" };
    },
  };
  const subagentProvider: ModelProvider = {
    modelId: "subagent-test",
    async *streamReply() { yield { kind: "text", text: "Repository inspected." }; },
  };
  const router: ModelProviderRouter = {
    kind: "model-router",
    resolve: () => subagentProvider,
    resolveTurn: () => turnProvider,
  };
  const daemon = new KernelDaemon({
    adapterDeps: { platform: "linux", policy: { rules: [{ capability: "task", decision: "allow", risk: "low" }] }, resolveProjectRoot: async () => projectRoot },
    commandGateway: {
      submitCommand: async () => "inbox-id",
      claimBatch: async () => pending.splice(0, 5),
      completeCommand: async () => undefined,
      renewLease: async () => undefined,
    },
    daemonHome,
    deploymentUrl: "http://unused",
    deviceToken: "device",
    heartbeatIntervalMs: 60_000,
    machineId: "machine",
    machineName: "task-test",
    pollIntervalMs: 60_000,
    projectionSink: {
      appendEvents: async ({ events }) => { projected.push(...events.map((event) => ({ payloadJson: event.payloadJson, type: event.type }))); },
      upsertSnapshot: async () => undefined,
      advanceCursor: async () => undefined,
    },
    providerRouter: router,
  });

  try {
    await runCommand({ command: "git init && git config user.email relay@example.test && git config user.name Relay && git commit --allow-empty -m baseline", platform: "linux", root: projectRoot });
    await daemon.start();
    await daemon.pollOnce();
    pending.push(command("inbox-send-task", "turn.send", runId, { projectPath: projectRoot, prompt: "delegate" }));
    await daemon.pollOnce();
    const deadline = Date.now() + 2_000;
    while (!projected.some((event) => event.type === "activity.completed" && JSON.parse(event.payloadJson).kind === "subagent:explore") && Date.now() < deadline) {
      await daemon.flushOnce();
      await Bun.sleep(10);
    }
    expect(projected.some((event) => event.type === "activity.completed" && JSON.parse(event.payloadJson).kind === "subagent:explore")).toBe(true);
  } finally {
    await daemon.stop();
    await rm(daemonHome, { force: true, recursive: true });
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("daemon routes Git actions through canonical lifecycle events", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-kernel-git-daemon-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "relay-kernel-git-project-"));
  const runId = "run-git-daemon";
  const pending = [
    command("inbox-create-git", "run.create", runId, { projectId: "project-git" }),
    command("inbox-resume-git", "run.resume", runId, {}),
  ];
  const projected: Array<{ eventId: string; type: string }> = [];
  const daemon = new KernelDaemon({
    adapterDeps: { platform: "linux", resolveProjectRoot: async () => projectRoot },
    commandGateway: {
      submitCommand: async () => "inbox-id",
      claimBatch: async () => pending.splice(0, 5),
      completeCommand: async () => undefined,
      renewLease: async () => undefined,
    },
    daemonHome,
    deploymentUrl: "http://unused",
    deviceToken: "device",
    heartbeatIntervalMs: 60_000,
    machineId: "machine",
    machineName: "git-test",
    pollIntervalMs: 60_000,
    projectionSink: {
      appendEvents: async ({ events }) => { projected.push(...events.map((event) => ({ eventId: event.eventId, type: event.type }))); },
      upsertSnapshot: async () => undefined,
      advanceCursor: async () => undefined,
    },
  });

  try {
    await runCommand({ command: "git init && git config user.email relay@example.test && git config user.name Relay && git commit --allow-empty -m baseline && printf 'change\n' > change.txt", platform: "linux", root: projectRoot });
    await daemon.start();
    await daemon.pollOnce();
    pending.push(command("inbox-git-stage", "git.action", runId, { action: "stage", projectPath: projectRoot }));
    await daemon.pollOnce();
    const deadline = Date.now() + 2_000;
    while (!projected.some((event) => event.type === "git.action.updated") && Date.now() < deadline) {
      await daemon.flushOnce();
      await Bun.sleep(10);
    }
    expect(projected.filter((event) => event.type === "git.action.updated")).toHaveLength(2);
    const status = await runCommand({ command: "git diff --cached --name-only", platform: "linux", root: projectRoot });
    expect(status.stdout.trim()).toBe("change.txt");
  } finally {
    await daemon.stop();
    await rm(daemonHome, { force: true, recursive: true });
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("daemon persists run configuration through a canonical lifecycle event", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-kernel-config-daemon-"));
  const runId = "run-config-daemon";
  const pending = [
    command("inbox-create-config", "run.create", runId, { mode: "plan", projectId: "project-config", title: "Configured plan" }, "/repo"),
    command("inbox-resume-config", "run.resume", runId, {}),
  ];
  const projected: Array<{ payloadJson: string; type: string }> = [];
  const daemon = new KernelDaemon({
    adapterDeps: {
      resolveProjectRoot: async () => ".",
      resolveSlashCommands: async () => [{ description: "Ship changes", name: "ship", scope: "builtin" }],
    },
    commandGateway: {
      submitCommand: async () => "inbox-id",
      claimBatch: async () => pending.splice(0, 5),
      completeCommand: async () => undefined,
      renewLease: async () => undefined,
    },
    daemonHome,
    deploymentUrl: "http://unused",
    deviceToken: "device",
    heartbeatIntervalMs: 60_000,
    machineId: "machine",
    machineName: "config-test",
    pollIntervalMs: 60_000,
    projectionSink: {
      appendEvents: async ({ events }) => { projected.push(...events.map((event) => ({ payloadJson: event.payloadJson, type: event.type }))); },
      upsertSnapshot: async () => undefined,
      advanceCursor: async () => undefined,
    },
  });

  try {
    await daemon.start();
    await daemon.pollOnce();
    pending.push(command("inbox-configure", "run.configure", runId, { budgetUsd: 7, modelId: "configured-model", permissionProfile: "read-only", thinkingLevel: "high" }));
    await daemon.pollOnce();
    const deadline = Date.now() + 2_000;
    while ((!projected.some((event) => event.type === "run.configuration.updated" && JSON.parse(event.payloadJson).budgetUsd !== undefined) || !projected.some((event) => event.type === "run.configuration.updated" && JSON.parse(event.payloadJson).slashCommands)) && Date.now() < deadline) {
      await daemon.flushOnce();
      await Bun.sleep(10);
    }
    expect(projected.map((event) => event.type)).toContain("run.configuration.updated");
    const configuration = projected.find((event) => event.type === "run.configuration.updated" && JSON.parse(event.payloadJson).budgetUsd !== undefined);
    expect(configuration ? JSON.parse(configuration.payloadJson) : undefined).toEqual({ budgetUsd: 7, modelId: "configured-model", permissionProfile: "read-only", thinkingLevel: "high" });
    const catalog = projected.find((event) => event.type === "run.configuration.updated" && JSON.parse(event.payloadJson).slashCommands);
    expect(catalog ? JSON.parse(catalog.payloadJson) : undefined).toEqual({ slashCommands: [{ description: "Ship changes", name: "ship", scope: "builtin" }] });
    const created = projected.find((event) => event.type === "run.created");
    expect(created ? JSON.parse(created.payloadJson) : undefined).toMatchObject({ mode: "plan", projectId: "project-config", title: "Configured plan" });
  } finally {
    await daemon.stop();
    await rm(daemonHome, { force: true, recursive: true });
  }
});

test("daemon routes canonical MCP elicitation commands through the device adapter", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-kernel-mcp-daemon-"));
  const runId = "run-mcp-daemon";
  const pending = [
    command("inbox-create-mcp", "run.create", runId, { projectId: "project-mcp" }),
    command("inbox-resolve-mcp", "mcp.elicitation.resolve", runId, { elicitationId: "elicitation-1", responseJson: '{"date":"2026-08-01"}' }),
    command("inbox-cancel-mcp", "mcp.elicitation.cancel", runId, { elicitationId: "elicitation-2" }),
  ];
  const resolved: string[] = [];
  const cancelled: string[] = [];
  const daemon = new KernelDaemon({
    adapterDeps: {
      resolveProjectRoot: async () => ".",
      mcp: {
        cancelMcpInput: async (elicitationId) => { cancelled.push(elicitationId); },
        listTools: async () => [],
        resolveMcpInput: async ({ elicitationId, responseJson }) => { resolved.push(`${elicitationId}:${responseJson}`); },
        callTool: async () => undefined,
      },
    },
    commandGateway: {
      submitCommand: async () => "inbox-id",
      claimBatch: async () => pending.splice(0, 5),
      completeCommand: async () => undefined,
      renewLease: async () => undefined,
    },
    daemonHome,
    deploymentUrl: "http://unused",
    deviceToken: "device",
    heartbeatIntervalMs: 60_000,
    machineId: "machine",
    machineName: "mcp-test",
    pollIntervalMs: 60_000,
    projectionSink: { appendEvents: async () => undefined, upsertSnapshot: async () => undefined, advanceCursor: async () => undefined },
  });
  try {
    await daemon.start();
    await daemon.pollOnce();
    expect(resolved).toEqual(['elicitation-1:{"date":"2026-08-01"}']);
    expect(cancelled).toEqual(["elicitation-2"]);
  } finally {
    await daemon.stop();
    await rm(daemonHome, { force: true, recursive: true });
  }
});

test("kernel plan mode projects an editable artifact and builds the approved revision", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-kernel-plan-daemon-"));
  const runId = "run-plan-daemon";
  const pending = [
    command("inbox-create-plan", "run.create", runId, { mode: "plan", projectId: "project-plan" }),
    command("inbox-resume-plan", "run.resume", runId, {}),
  ];
  const projected: Array<{ payloadJson: string; type: string }> = [];
  const provider: TurnModelProvider = {
    modelId: "plan-test",
    async *streamTurn({ system }) {
      yield { kind: "text", text: system.includes("PLANNING PHASE") ? "draft plan" : "built result" };
      yield { kind: "stop", reason: "end_turn" };
    },
  };
  const daemon = new KernelDaemon({
    adapterDeps: { platform: "linux", resolveProjectRoot: async () => "." },
    commandGateway: {
      submitCommand: async () => "inbox-id",
      claimBatch: async () => pending.splice(0, 5),
      completeCommand: async () => undefined,
      renewLease: async () => undefined,
    },
    daemonHome,
    deploymentUrl: "http://unused",
    deviceToken: "device",
    heartbeatIntervalMs: 60_000,
    machineId: "machine",
    machineName: "plan-test",
    pollIntervalMs: 60_000,
    projectionSink: {
      appendEvents: async ({ events }) => { projected.push(...events.map((event) => ({ payloadJson: event.payloadJson, type: event.type }))); },
      upsertSnapshot: async () => undefined,
      advanceCursor: async () => undefined,
    },
    providerRouter: {
      kind: "model-router",
      resolve: () => ({ modelId: "plan-test", async *streamReply() {} }),
      resolveTurn: () => provider,
    },
  });

  const waitFor = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!predicate() && Date.now() < deadline) {
      await daemon.flushOnce();
      await Bun.sleep(10);
    }
    expect(predicate()).toBe(true);
  };

  try {
    await daemon.start();
    await daemon.pollOnce();
    pending.push(command("inbox-plan-send", "turn.send", runId, { prompt: "Plan the change" }));
    await daemon.pollOnce();
    await waitFor(() => projected.some((event) => event.type === "plan.updated" && JSON.parse(event.payloadJson).phase === "review"));

    pending.push(command("inbox-plan-update", "plan.update", runId, { content: "edited plan", expectedRevision: 0 }));
    await daemon.pollOnce();
    await waitFor(() => projected.some((event) => event.type === "plan.updated" && JSON.parse(event.payloadJson).revision === 1));

    pending.push(command("inbox-plan-approve", "plan.approve", runId, { content: "edited plan", expectedRevision: 1 }));
    await daemon.pollOnce();
    await waitFor(() => projected.some((event) => event.type === "plan.updated" && JSON.parse(event.payloadJson).phase === "complete"));

    const phases = projected.filter((event) => event.type === "plan.updated").map((event) => JSON.parse(event.payloadJson).phase);
    expect(phases).toEqual(["planning", "review", "review", "building", "complete"]);
    expect(projected.filter((event) => event.type === "plan.updated").map((event) => JSON.parse(event.payloadJson).content).filter(Boolean)).toEqual(["draft plan", "edited plan", "edited plan"]);
  } finally {
    await daemon.stop();
    await rm(daemonHome, { force: true, recursive: true });
  }
});

test("kernel MCP task status is projected as canonical activity", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-kernel-mcp-task-daemon-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "relay-kernel-mcp-task-project-"));
  const runId = "run-mcp-task-daemon";
  const pending = [
    command("inbox-create-mcp-task", "run.create", runId, { projectId: "project-mcp-task", projectPath: projectRoot }, projectRoot),
    command("inbox-resume-mcp-task", "run.resume", runId, {}, projectRoot),
  ];
  const projected: Array<{ payloadJson: string; type: string }> = [];
  const legacyStatuses: string[] = [];
  let turnCalls = 0;
  const provider: TurnModelProvider = {
    modelId: "mcp-task-test",
    async *streamTurn() {
      if (turnCalls++ === 0) {
        yield { kind: "tool_use", call: { arguments: {}, kind: "mcp", name: "long_task", risk: "low", serverId: "server" }, id: "mcp-task-1" };
        yield { kind: "stop", reason: "tool_use" };
        return;
      }
      yield { kind: "text", text: "task complete" };
      yield { kind: "stop", reason: "end_turn" };
    },
  };
  const daemon = new KernelDaemon({
    adapterDeps: {
      governance: { recordDecision: async () => undefined, requestApproval: async () => "deny" },
      mcp: {
        callTool: async ({ onTaskStatus }) => {
          await onTaskStatus?.({ id: "task-1", status: "working" });
          await onTaskStatus?.({ id: "task-1", status: "completed" });
          return { ok: true };
        },
        listTools: async () => [],
        recordTaskStatus: async ({ status }) => { legacyStatuses.push(status); },
      },
      policy: { rules: [{ capability: "exec", decision: "allow", risk: "low" }] },
      platform: "linux",
      resolveProjectRoot: async () => projectRoot,
    },
    commandGateway: {
      submitCommand: async () => "inbox-id",
      claimBatch: async () => pending.splice(0, 5),
      completeCommand: async () => undefined,
      renewLease: async () => undefined,
    },
    daemonHome,
    deploymentUrl: "http://unused",
    deviceToken: "device",
    heartbeatIntervalMs: 60_000,
    machineId: "machine",
    machineName: "mcp-task-test",
    pollIntervalMs: 60_000,
    projectionSink: {
      appendEvents: async ({ events }) => { projected.push(...events.map((event) => ({ payloadJson: event.payloadJson, type: event.type }))); },
      upsertSnapshot: async () => undefined,
      advanceCursor: async () => undefined,
    },
    providerRouter: {
      kind: "model-router",
      resolve: () => ({ modelId: "mcp-task-test", async *streamReply() {} }),
      resolveTurn: () => provider,
    },
  });
  try {
    await runCommand({ command: "git init && git config user.email relay@example.test && git config user.name Relay && git commit --allow-empty -m baseline", platform: "linux", root: projectRoot });
    await daemon.start();
    await daemon.pollOnce();
    pending.push(command("inbox-mcp-task-send", "turn.send", runId, { projectPath: projectRoot, prompt: "run the task" }, projectRoot));
    await daemon.pollOnce();
    const deadline = Date.now() + 2_000;
    while (!projected.some((event) => event.type === "activity.completed" && JSON.parse(event.payloadJson).kind === "mcp:task") && Date.now() < deadline) {
      await daemon.flushOnce();
      await Bun.sleep(10);
    }
    const taskEvents = projected.filter((event) => JSON.parse(event.payloadJson).kind === "mcp:task");
    expect(taskEvents.map((event) => event.type)).toEqual(["activity.started", "activity.delta", "activity.completed"]);
    expect(legacyStatuses).toEqual([]);
  } finally {
    await daemon.stop();
    await rm(daemonHome, { force: true, recursive: true });
    await rm(projectRoot, { force: true, recursive: true });
  }
});

function command(commandId: string, kind: string, runId: string, payload: unknown, projectPath?: string) {
  return {
    commandId,
    correlationId: `corr-${commandId}`,
    externalCommandId: commandId,
    kind,
    leaseGeneration: 1,
    payloadJson: JSON.stringify(payload),
    ...(projectPath ? { projectPath } : {}),
    runId,
  };
}
