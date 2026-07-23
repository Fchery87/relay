// ---------------------------------------------------------------------------
// Protected real-provider harness lifecycle.
//
// This test is deliberately opt-in. It uses the installed Codex app-server,
// a temporary Git workspace, the real KernelDaemon, and a persistent local
// SQLite runtime. Ordinary CI remains deterministic and does not require
// provider credentials.
// ---------------------------------------------------------------------------

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { KernelDaemon } from "./kernel-daemon";
import { runCommand } from "./tools";
import { resolveCodexHarnessHome } from "./codex-harness-home";

const enabled = Bun.env.RELAY_E2E_CODEX === "1";

type ProjectedEvent = {
  readonly eventId: string;
  readonly runId: string;
  readonly type: string;
  readonly payloadJson?: string;
};

type PendingCommand = {
  readonly commandId: string;
  readonly correlationId: string;
  readonly externalCommandId: string;
  readonly kind: string;
  readonly leaseGeneration: number;
  readonly payloadJson: string;
  readonly runId: string;
};

function command(commandId: string, kind: string, runId: string, payload: unknown): PendingCommand {
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

async function waitForTurn(daemon: KernelDaemon, events: ProjectedEvent[], turnId: string): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await daemon.flushOnce();
    if (events.some((event) => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type))) return;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for Codex turn ${turnId}; saw ${events.map((event) => event.type).join(", ")}`);
}

function payload(event: ProjectedEvent): Record<string, unknown> {
  return event.payloadJson ? JSON.parse(event.payloadJson) as Record<string, unknown> : {};
}

describe.skipIf(!enabled)("real Codex harness lifecycle", () => {
  test("streams, edits a durable workspace, checkpoints, and resumes after daemon restart", async () => {
    // KernelDaemon gates provider construction on this daemon-only switch;
    // the public smoke flag remains RELAY_E2E_CODEX for protected runners.
    Bun.env.RELAY_CODEX_ENABLED = "1";
    const daemonHome = await mkdtemp(join(tmpdir(), "relay-codex-harness-daemon-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "relay-codex-harness-project-"));
    const previousCodexHome = Bun.env.CODEX_HOME;
    // Keep protected CI hermetic by default, but allow an explicit local run
    // to use a user-authenticated Codex home (for example, ChatGPT login)
    // without copying or printing its credentials.
    const codexHome = resolveCodexHarnessHome(daemonHome, Bun.env.RELAY_CODEX_HOME);
    Bun.env.CODEX_HOME = codexHome.path;
    await mkdir(Bun.env.CODEX_HOME, { recursive: true });
    try {
    const runId = "run-real-codex-harness";
    const events: ProjectedEvent[] = [];
    const pending: PendingCommand[] = [
      command("codex-create", "run.create", runId, { projectId: "project-real-codex", projectPath: projectRoot }),
      command("codex-resume", "run.resume", runId, {}),
    ];
    const completedCommands: string[] = [];
    const commandGateway = {
      submitCommand: async () => "unused",
      claimBatch: async () => pending.splice(0, 5),
      completeCommand: async ({ commandId }: { commandId: string }) => { completedCommands.push(commandId); },
      renewLease: async () => undefined,
    };
    const projectionSink = {
      appendEvents: async ({ events: batch }: { events: ProjectedEvent[] }) => { events.push(...batch); },
      upsertSnapshot: async () => undefined,
      advanceCursor: async () => undefined,
    };
    const config = {
      adapterDeps: {
        platform: "linux" as const,
        resolveProjectRoot: async ({ repoPath }: { repoPath: string }) => repoPath,
      },
      codexTransport: {
        enabled: true,
        codexPath: Bun.env.RELAY_CODEX_PATH,
        clientInfo: { name: "relay-protected-harness", version: "1.0.0" },
      },
      commandGateway,
      daemonHome,
      deploymentUrl: "http://unused",
      deviceToken: "device-real-codex",
      heartbeatIntervalMs: 60_000,
      machineId: "machine-real-codex",
      machineName: "real-codex-harness",
      pollIntervalMs: 60_000,
      projectionSink,
    };

    await runCommand({ command: "git init && git config user.email relay@example.test && git config user.name Relay", platform: "linux", root: projectRoot });
    await writeFile(join(projectRoot, "fixture.txt"), "before\n");
    await runCommand({ command: "git add fixture.txt && git commit -m baseline", platform: "linux", root: projectRoot });

    const daemon1 = new KernelDaemon(config);
    try {
      await daemon1.start();
      await daemon1.pollOnce();

      const firstTurnId = "turn-codex-edit";
      pending.push(command("codex-edit", "turn.send", runId, {
        projectPath: projectRoot,
        prompt: "In the current workspace, edit fixture.txt so it contains exactly the single line `after`. Use your file editing tool, then reply briefly that it is done.",
      }));
      await daemon1.pollOnce();
      await waitForTurn(daemon1, events, firstTurnId);

      expect(await readFile(join(projectRoot, "fixture.txt"), "utf8")).toBe("after\n");
      expect(events.some((event) => event.type === "provider.session.started" && payload(event).providerThreadId)).toBe(true);
      expect(events.some((event) => event.type === "assistant.delta")).toBe(true);
      expect(events.filter((event) => event.type === "checkpoint.captured")).toHaveLength(2);
      expect(completedCommands).toContain("codex-edit");
    } finally {
      await daemon1.stop();
    }

    const daemon2 = new KernelDaemon(config);
    try {
      const secondTurnId = "turn-codex-resume";
      pending.push(command("codex-resume-turn", "turn.send", runId, {
        projectPath: projectRoot,
        prompt: "Reply with exactly the word RESTARTED. Do not modify any files.",
      }));
      await daemon2.start();
      await daemon2.pollOnce();
      await waitForTurn(daemon2, events, secondTurnId);
      expect(events.some((event) => event.type === "provider.session.resumed")).toBe(true);
      expect(events.filter((event) => event.type === "assistant.delta").length).toBeGreaterThan(1);
      expect(events.filter((event) => event.type === "turn.completed").length).toBeGreaterThan(1);
      expect(await readFile(join(projectRoot, "fixture.txt"), "utf8")).toBe("after\n");
    } finally {
      await daemon2.stop();
    }
    } finally {
      if (previousCodexHome === undefined) delete Bun.env.CODEX_HOME;
      else Bun.env.CODEX_HOME = previousCodexHome;
      await rm(daemonHome, { force: true, recursive: true });
      await rm(projectRoot, { force: true, recursive: true });
    }
  }, 15 * 60_000);
});
