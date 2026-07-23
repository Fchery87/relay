import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KernelDaemon } from "./kernel-daemon";
import type { ModelProviderRouter, ModelProvider } from "./model-provider";
import type { TurnModelProvider, TurnStreamEvent } from "./turn-loop";
import { runCommand } from "./tools";

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

function command(commandId: string, kind: string, runId: string, payload: unknown) {
  return {
    commandId,
    correlationId: `corr-${commandId}`,
    externalCommandId: commandId,
    kind,
    leaseGeneration: 1,
    payloadJson: JSON.stringify(payload),
    runId,
  };
}
