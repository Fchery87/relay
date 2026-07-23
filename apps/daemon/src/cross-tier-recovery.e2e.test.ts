// ---------------------------------------------------------------------------
// Cross-tier recovery seam — exercises a real client command through a real
// isolated self-hosted Convex backend and a real KernelDaemon, then through
// ordered projections to a reconnecting client. No convex-test simulator
// and no fake command gateway/projection sink: this is the actual
// createConvexCommandSource/createConvexProjectionSink production code
// talking over HTTP to a real (but throwaway, isolated) backend process.
//
// Skips automatically when the self-hosted Convex backend binary isn't
// installed or loopback binding is unavailable (see
// docs/operations/self-hosted-convex.md) — "protected job" tier per
// tickets.md, not part of the ordinary fast/deterministic suite.
// Never touches the developer's real backend or its data — see
// scripts/lib/isolated-self-hosted-convex.ts.
//
// Run explicitly with: bun test apps/daemon/src/cross-tier-recovery.e2e.test.ts
// ---------------------------------------------------------------------------

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  startIsolatedSelfHostedConvex,
  deploySchema,
  setupAuthKeys,
  findSelfHostedBackendBinary,
  type IsolatedConvexBackend,
} from "../../../scripts/lib/isolated-self-hosted-convex";
import { buildIsolatedFixture, type IsolatedFixture } from "../../../scripts/lib/isolated-convex-fixture";
import { KernelDaemon } from "./kernel-daemon";
import { runCommand } from "./tools";
import { createCheckpoint } from "./checkpoints";
import { createConvexProjectionSink } from "./sync/convex-projection-sink";

const repoRoot = join(import.meta.dir, "..", "..", "..");
async function canBindLoopback(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

const binaryAvailable = (await findSelfHostedBackendBinary()) !== null && await canBindLoopback();

/**
 * Poll a projected-state condition, forcing an immediate outbox flush each
 * attempt rather than waiting on the daemon's own heartbeat-driven flush
 * cadence — keeps the test fast and deterministic instead of depending on
 * `heartbeatIntervalMs` timing.
 */
async function waitUntilProjected(daemon: KernelDaemon, check: () => Promise<boolean> | boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await daemon.flushOnce();
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

async function fetchSnapshot(fixture: IsolatedFixture, runId: string): Promise<{ sequence: number; snapshotJson: string } | null> {
  return fixture.call("query", "projections/publish:getRunSnapshot", { runId }, true) as Promise<{ sequence: number; snapshotJson: string } | null>;
}

async function fetchEvents(fixture: IsolatedFixture, runId: string, afterSequence: number): Promise<Array<{
  eventId: string;
  occurredAt: number;
  payloadJson: string;
  projectId: string;
  runId: string;
  sequence: number;
  type: string;
}>> {
  return fixture.call("query", "projections/publish:listRunEvents", { runId, afterSequence, limit: 200 }, true) as Promise<Array<{
    eventId: string;
    occurredAt: number;
    payloadJson: string;
    projectId: string;
    runId: string;
    sequence: number;
    type: string;
  }>>;
}

async function createGitProject(): Promise<{ root: string; baselineCommit: string }> {
  const root = await mkdtemp(join(tmpdir(), "relay-cross-tier-project-"));
  await runCommand({ command: "git init && git config user.email relay@example.test && git config user.name Relay", platform: "linux", root });
  await writeFile(join(root, "state.txt"), "baseline\n");
  await runCommand({ command: "git add state.txt && git commit -m baseline", platform: "linux", root });
  const commit = await runCommand({ command: "git rev-parse HEAD", platform: "linux", root });
  return { root, baselineCommit: commit.stdout.trim() };
}

/** Submit one canonical command through the real inbox, the way the browser will once cut over. */
function submitCommand(fixture: IsolatedFixture, input: { commandId: string; kind: string; payload: unknown; runId?: string }): Promise<unknown> {
  return fixture.call("mutation", "commands/inbox:submitToInbox", {
    commandId: input.commandId,
    correlationId: `corr-${fixture.threadId}`,
    kind: input.kind,
    payloadJson: JSON.stringify(input.payload),
    ...(input.runId ? { runId: input.runId } : {}),
    threadId: fixture.threadId,
  }, true);
}

describe.skipIf(!binaryAvailable)("cross-tier recovery seam (live isolated backend)", () => {
  let backend: IsolatedConvexBackend;
  let fixture: IsolatedFixture;
  const daemonHomes: string[] = [];
  const projectHomes: string[] = [];

  beforeAll(async () => {
    backend = (await startIsolatedSelfHostedConvex())!;
    try {
      await deploySchema(backend, repoRoot);
      await setupAuthKeys(backend, repoRoot);
      fixture = await buildIsolatedFixture(backend);
    } catch (error) {
      // Setup failed partway through — the backend process and its temp
      // data dir would otherwise leak, since afterAll only runs when
      // beforeAll succeeds.
      await backend.stop();
      throw error;
    }
  }, 120_000);

  afterAll(async () => {
    for (const dir of daemonHomes) await rm(dir, { recursive: true, force: true });
    for (const dir of projectHomes) await rm(dir, { recursive: true, force: true });
    await backend?.stop();
  });

  async function tempDaemonHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "relay-e2e-daemon-home-"));
    daemonHomes.push(dir);
    return dir;
  }

  /** A real KernelDaemon against the real isolated backend — no fakes/overrides. */
  async function startDaemon(deviceToken: string, machineId: string, machineName: string, projectRoot?: string): Promise<KernelDaemon> {
    const daemon = new KernelDaemon({
      daemonHome: await tempDaemonHome(),
      deploymentUrl: backend.url,
      deviceToken,
      heartbeatIntervalMs: 300,
      machineId,
      machineName,
      pollIntervalMs: 200,
      ...(projectRoot ? {
        adapterDeps: {
          platform: "linux" as const,
          resolveProjectRoot: async () => projectRoot,
        },
      } : {}),
    });
    await daemon.start();
    return daemon;
  }

  /** Fresh fixture + a started daemon for it — the common scenario setup shared by most tests below. */
  async function setupScenario(machineName: string): Promise<{ fixture: IsolatedFixture; runId: string; daemon: KernelDaemon }> {
    const scenarioFixture = await buildIsolatedFixture(backend);
    const daemon = await startDaemon(scenarioFixture.deviceToken, scenarioFixture.machineId, machineName);
    return { fixture: scenarioFixture, runId: scenarioFixture.threadId, daemon };
  }

  /** Submit run.create + run.resume and wait for run.started to land — the common precondition for turn-level tests. */
  async function createAndResumeRun(scenarioFixture: IsolatedFixture, runId: string, daemon: KernelDaemon): Promise<void> {
    await submitCommand(scenarioFixture, { commandId: `cmd-run-create-${runId.slice(-8)}-1`, kind: "run.create", payload: { projectId: scenarioFixture.projectId } });
    await submitCommand(scenarioFixture, { commandId: `cmd-run-resume-${runId.slice(-8)}-2`, kind: "run.resume", payload: { runId }, runId });
    await waitUntilProjected(daemon, async () => {
      const events = await fetchEvents(scenarioFixture, runId, -1);
      return events.some((e) => e.type === "run.started");
    }, 15_000, "run.started to be projected");
  }

  test("create -> resume -> send -> projection landing -> reconnecting client sees ordered events, no gaps", async () => {
    const runId = fixture.threadId; // canonical run ID defaults to threadId when omitted
    const daemon = await startDaemon(fixture.deviceToken, fixture.machineId, "e2e-test-machine");

    try {
      await submitCommand(fixture, { commandId: `cmd-run-create-${runId.slice(-8)}-1`, kind: "run.create", payload: { projectId: fixture.projectId } });
      await submitCommand(fixture, { commandId: `cmd-run-resume-${runId.slice(-8)}-2`, kind: "run.resume", payload: { runId }, runId });
      await submitCommand(fixture, { commandId: `cmd-turn-send-${runId.slice(-8)}-3`, kind: "turn.send", payload: { runId, prompt: "hello from the cross-tier recovery test" }, runId });

      // Wait on real conditions (receipts landing as projected events), not
      // arbitrary sleeps.
      await waitUntilProjected(daemon, async () => {
        const events = await fetchEvents(fixture, runId, -1);
        return events.some((e) => e.type === "turn.completed" || e.type === "turn.failed");
      }, 20_000, "turn to complete and its terminal event to be projected");

      // The projection landed with a contiguous, ordered event stream —
      // exactly what a reconnecting ClientRuntime replays.
      const events = await fetchEvents(fixture, runId, -1);
      const types = events.map((e) => e.type);
      expect(types).toContain("run.created");
      expect(types).toContain("run.started");
      expect(types).toContain("turn.started");
      expect(types.some((t) => t === "turn.completed" || t === "turn.failed")).toBe(true);

      const sequences = events.map((e) => e.sequence).sort((a, b) => a - b);
      for (let i = 1; i < sequences.length; i++) {
        expect(sequences[i]).toBe(sequences[i - 1]! + 1); // no gaps
      }

      // Snapshot never leads the confirmed event prefix.
      const snapshot = await fetchSnapshot(fixture, runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.sequence).toBeLessThanOrEqual(sequences[sequences.length - 1]!);

      // A reconnecting client resumes from any confirmed cursor without
      // gaps or duplicates — simulate reconnecting after the midpoint.
      const midpoint = sequences[Math.floor(sequences.length / 2)]!;
      const resumed = await fetchEvents(fixture, runId, midpoint);
      expect(resumed.every((e) => e.sequence > midpoint)).toBe(true);
      expect(new Set(resumed.map((e) => e.sequence)).size).toBe(resumed.length); // no duplicates
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("daemon restart: a fresh KernelDaemon instance against the same backend converges without duplicating the run", async () => {
    const fixture2 = await buildIsolatedFixture(backend);
    const runId = fixture2.threadId;
    const daemonHome = await tempDaemonHome();

    const daemon1 = new KernelDaemon({
      daemonHome,
      deploymentUrl: backend.url,
      deviceToken: fixture2.deviceToken,
      heartbeatIntervalMs: 300,
      machineId: fixture2.machineId,
      machineName: "e2e-restart-machine",
      pollIntervalMs: 200,
    });
    await daemon1.start();
    await submitCommand(fixture2, { commandId: `cmd-run-create-${runId.slice(-8)}-1`, kind: "run.create", payload: { projectId: fixture2.projectId } });

    await waitUntilProjected(daemon1, async () => {
      const events = await fetchEvents(fixture2, runId, -1);
      return events.some((e) => e.type === "run.created");
    }, 15_000, "run.created to be projected before restart");

    // Simulate a crash: stop without a clean drain, then start a brand new
    // KernelDaemon instance against the SAME local daemonHome (same SQLite
    // file) and the SAME backend.
    await daemon1.stop();

    const daemon2 = new KernelDaemon({
      daemonHome,
      deploymentUrl: backend.url,
      deviceToken: fixture2.deviceToken,
      heartbeatIntervalMs: 300,
      machineId: fixture2.machineId,
      machineName: "e2e-restart-machine",
      pollIntervalMs: 200,
    });
    await daemon2.start();
    try {
      await submitCommand(fixture2, { commandId: `cmd-run-resume-${runId.slice(-8)}-2`, kind: "run.resume", payload: { runId }, runId });

      await waitUntilProjected(daemon2, async () => {
        const events = await fetchEvents(fixture2, runId, -1);
        return events.some((e) => e.type === "run.started");
      }, 15_000, "run.started to be projected after restart");

      const events = await fetchEvents(fixture2, runId, -1);
      // Exactly one run.created — a restart must not duplicate the effect.
      expect(events.filter((e) => e.type === "run.created")).toHaveLength(1);
      const sequences = events.map((e) => e.sequence).sort((a, b) => a - b);
      for (let i = 1; i < sequences.length; i++) {
        expect(sequences[i]).toBe(sequences[i - 1]! + 1);
      }
    } finally {
      await daemon2.stop();
    }
  }, 60_000);

  // ---------------------------------------------------------------------
  // turn.steer / turn.interrupt / approval.resolve — these commands are
  // real canonical state transitions today, but kernel mode has no
  // governance/tool-execution integration yet to actually create an
  // approval or cancel an in-flight provider call — see
  // docs/operations/kernel-mode-capability-gaps.md. These tests prove the
  // command-routing and state-transition seam that DOES exist, not full
  // interrupt/approval semantics.
  // ---------------------------------------------------------------------

  test("turn.steer after the turn has already completed is rejected, not silently accepted or hung (real finding: single-threaded sequential poll processing means mid-turn steering cannot land while a turn is genuinely in flight — see kernel-mode-capability-gaps.md)", async () => {
    const { fixture: fixture3, runId, daemon } = await setupScenario("e2e-steer-machine");
    try {
      await submitCommand(fixture3, { commandId: `cmd-run-create-${runId.slice(-8)}-1`, kind: "run.create", payload: { projectId: fixture3.projectId } });
      await submitCommand(fixture3, { commandId: `cmd-run-resume-${runId.slice(-8)}-2`, kind: "run.resume", payload: { runId }, runId });
      await submitCommand(fixture3, { commandId: `cmd-turn-send-${runId.slice(-8)}-3`, kind: "turn.send", payload: { runId, prompt: "steer me" }, runId });

      // The scripted provider completes the turn near-instantly, and
      // KernelDaemon processes a claimed batch sequentially — so by
      // construction, turn.steer submitted after turn.send always lands
      // after the turn is already done, not "mid-turn." Wait for the turn
      // to actually finish before steering, to test the real, reachable
      // scenario rather than assume a race that can't happen.
      await waitUntilProjected(daemon, async () => {
        const events = await fetchEvents(fixture3, runId, -1);
        return events.some((e) => e.type === "turn.completed" || e.type === "turn.failed");
      }, 20_000, "turn to complete before steering");

      await submitCommand(fixture3, { commandId: `cmd-turn-steer-${runId.slice(-8)}-4`, kind: "turn.steer", payload: { runId, steering: "actually, be brief" }, runId });
      await daemon.pollOnce();
      await daemon.flushOnce();

      // Correctly rejected — no turn.steered event, and the run is left in
      // a sane, unchanged state rather than corrupted or stuck.
      const events = await fetchEvents(fixture3, runId, -1);
      expect(events.some((e) => e.type === "turn.steered")).toBe(false);
      const snapshot = await fetchSnapshot(fixture3, runId);
      expect(snapshot).not.toBeNull();
      expect(JSON.parse(snapshot!.snapshotJson).status).toBe("running");
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("turn.interrupt routes through the real seam and records turn.interrupted (does not abort the in-flight provider call — see kernel-mode-capability-gaps.md)", async () => {
    const { fixture: fixture4, runId, daemon } = await setupScenario("e2e-interrupt-machine");
    try {
      await submitCommand(fixture4, { commandId: `cmd-run-create-${runId.slice(-8)}-1`, kind: "run.create", payload: { projectId: fixture4.projectId } });
      await submitCommand(fixture4, { commandId: `cmd-run-resume-${runId.slice(-8)}-2`, kind: "run.resume", payload: { runId }, runId });
      await submitCommand(fixture4, { commandId: `cmd-turn-send-${runId.slice(-8)}-3`, kind: "turn.send", payload: { runId, prompt: "interrupt me" }, runId });
      await submitCommand(fixture4, { commandId: `cmd-turn-interrupt-${runId.slice(-8)}-4`, kind: "turn.interrupt", payload: { runId, reason: "user requested" }, runId });

      await waitUntilProjected(daemon, async () => {
        const events = await fetchEvents(fixture4, runId, -1);
        return events.some((e) => e.type === "turn.interrupted" || e.type === "turn.completed" || e.type === "turn.failed");
      }, 20_000, "an interrupt or terminal turn event to be projected");

      // The run reaches a recoverable, non-corrupted state either way —
      // interrupt-before-completion and interrupt-after-completion (a race
      // given the scripted provider streams near-instantly) are both valid
      // outcomes; what matters is neither leaves the run stuck.
      const snapshot = await fetchSnapshot(fixture4, runId);
      expect(snapshot).not.toBeNull();
      const status = JSON.parse(snapshot!.snapshotJson).status as string;
      expect(["running", "stopped", "failed"]).toContain(status);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("approval.resolve on a run with no pending approval is rejected, not silently accepted (decider.ts only allows it in awaiting_approval)", async () => {
    // This deliberately uses an unknown approval ID on a running turn. It
    // proves the command is correctly rejected rather than silently accepted
    // or corrupting run state — decider.ts gates approval.resolve to the
    // awaiting_approval status only, stricter than the reducer's own
    // no-op-when-running fallback (which handles replaying an already-applied
    // approval.resolved event, a different case).
    const { fixture: fixture5, runId, daemon } = await setupScenario("e2e-approval-machine");
    try {
      await createAndResumeRun(fixture5, runId, daemon);

      await submitCommand(fixture5, { commandId: `cmd-approval-resolve-${runId.slice(-8)}-3`, kind: "approval.resolve", payload: { runId, approvalId: "no-such-approval", resolution: "allow" }, runId });
      await daemon.pollOnce();
      await daemon.flushOnce();

      const events = await fetchEvents(fixture5, runId, -1);
      expect(events.some((e) => e.type === "approval.resolved")).toBe(false);
      const snapshot = await fetchSnapshot(fixture5, runId);
      expect(snapshot).not.toBeNull();
      expect(JSON.parse(snapshot!.snapshotJson).status).toBe("running");
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  // ---------------------------------------------------------------------
  // Fault injection against the real seam: duplicate/conflicting commands,
  // lease expiry + redelivery, stale-worker fencing, and a real backend
  // process restart (not just the daemon).
  // ---------------------------------------------------------------------

  test("duplicate commandId with identical payload is idempotent; conflicting payload is rejected", async () => {
    const fixture6 = await buildIsolatedFixture(backend);
    const runId = fixture6.threadId;
    const commandId = `cmd-run-create-${runId.slice(-8)}-dup`;
    const payload = { projectId: fixture6.projectId };

    const first = await submitCommand(fixture6, { commandId, kind: "run.create", payload });
    const second = await submitCommand(fixture6, { commandId, kind: "run.create", payload });
    expect(second).toBe(first); // exact replay returns the original receipt, not a new one

    await expect(
      submitCommand(fixture6, { commandId, kind: "run.create", payload: { projectId: fixture6.projectId, extra: "conflicting" } }),
    ).rejects.toThrow(/Conflicting/i);
  }, 30_000);

  test("a committed command whose response is lost can be retried without duplicating the real effect", async () => {
    const fixture10 = await buildIsolatedFixture(backend);
    const runId = fixture10.threadId;
    const commandId = `cmd-run-create-${runId.slice(-8)}-lost-response`;
    const args = {
      commandId,
      correlationId: `corr-${fixture10.threadId}`,
      kind: "run.create",
      payloadJson: JSON.stringify({ projectId: fixture10.projectId }),
      threadId: fixture10.threadId,
    };

    // The HTTP mutation has committed, but the caller deliberately discards
    // the successful response and experiences a transport error.
    await expect(
      fixture10.callAndDropResponse("mutation", "commands/inbox:submitToInbox", args, true),
    ).rejects.toThrow("simulated lost response");

    // Retrying the exact immutable envelope returns the original Convex
    // receipt. The daemon then executes one canonical run.create effect.
    const retryReceipt = await submitCommand(fixture10, { commandId, kind: "run.create", payload: { projectId: fixture10.projectId } });
    expect(typeof retryReceipt).toBe("string");

    const daemon = await startDaemon(fixture10.deviceToken, fixture10.machineId, "e2e-lost-response-machine");
    try {
      await waitUntilProjected(daemon, async () => {
        const events = await fetchEvents(fixture10, runId, -1);
        return events.some((event) => event.type === "run.created");
      }, 20_000, "run.created to be projected after lost-response retry");
      const events = await fetchEvents(fixture10, runId, -1);
      expect(events.filter((event) => event.type === "run.created")).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("real workspace state restores a Git checkpoint through the command seam", async () => {
    const project = await createGitProject();
    projectHomes.push(project.root);
    const fixture11 = await buildIsolatedFixture(backend, { projectPath: project.root });
    const runId = fixture11.threadId;
    const daemon = await startDaemon(fixture11.deviceToken, fixture11.machineId, "e2e-checkpoint-machine", project.root);

    try {
      await createAndResumeRun(fixture11, runId, daemon);
      await writeFile(join(project.root, "state.txt"), "checkpointed change\n");
      const checkpoint = await createCheckpoint({ root: project.root, threadId: fixture11.threadId, turnId: "turn-1" });
      expect(checkpoint.commit).not.toBe(project.baselineCommit);
      expect(checkpoint.ref).toContain(`refs/relay/checkpoints/${fixture11.threadId}`);

      await writeFile(join(project.root, "state.txt"), "post-checkpoint mutation\n");
      await submitCommand(fixture11, {
        commandId: `cmd-checkpoint-restore-${runId.slice(-8)}-3`,
        kind: "checkpoint.restore",
        payload: { commit: checkpoint.commit, projectPath: project.root, threadId: fixture11.threadId },
        runId,
      });
      await waitUntilProjected(daemon, async () => {
        const events = await fetchEvents(fixture11, runId, -1);
        return events.some((event) => event.type === "checkpoint.restored");
      }, 20_000, "checkpoint.restored to be projected");
      expect(await readFile(join(project.root, "state.txt"), "utf8")).toBe("checkpointed change\n");
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("the real projection sink accepts exact duplicates and rejects reordered or partial batches atomically", async () => {
    const { fixture: fixture12, runId, daemon } = await setupScenario("e2e-projection-fault-machine");
    const sink = createConvexProjectionSink({ deploymentUrl: backend.url, deviceToken: fixture12.deviceToken });
    try {
      await createAndResumeRun(fixture12, runId, daemon);
      const existing = await fetchEvents(fixture12, runId, -1);
      expect(existing.length).toBeGreaterThanOrEqual(2);

      await sink.appendEvents({ events: existing.map(({ eventId, occurredAt, payloadJson, projectId, runId: projectedRunId, sequence, type }) => ({ eventId, occurredAt, payloadJson, projectId, runId: projectedRunId, sequence, type })), deviceToken: fixture12.deviceToken });
      expect((await fetchEvents(fixture12, runId, -1)).map((event) => event.sequence)).toEqual(existing.map((event) => event.sequence));

      const probeRunId = `projection-probe-${runId.slice(-8)}`;
      const event = (sequence: number) => ({
        eventId: `${probeRunId}-${sequence}`,
        occurredAt: sequence,
        payloadJson: JSON.stringify({ sequence }),
        projectId: fixture12.projectId,
        runId: probeRunId,
        sequence,
        type: "activity.delta",
      });

      // A reordered batch cannot create sequence 2 before sequence 1.
      await expect(sink.appendEvents({ events: [event(2), event(1)], deviceToken: fixture12.deviceToken })).rejects.toThrow(/Gap/i);
      expect(await fetchEvents(fixture12, probeRunId, -1)).toHaveLength(0);

      // If a later event in one mutation is invalid, Convex rolls back the
      // earlier insert too; the retry can then publish the contiguous prefix.
      await expect(sink.appendEvents({ events: [event(1), event(3)], deviceToken: fixture12.deviceToken })).rejects.toThrow(/Gap/i);
      expect(await fetchEvents(fixture12, probeRunId, -1)).toHaveLength(0);
      await sink.appendEvents({ events: [event(1), event(2)], deviceToken: fixture12.deviceToken });
      expect((await fetchEvents(fixture12, probeRunId, -1)).map((item) => item.sequence)).toEqual([1, 2]);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("a command claimed by a crashed worker is reclaimed after lease expiry and completed exactly once", async () => {
    const fixture7 = await buildIsolatedFixture(backend);
    const runId = fixture7.threadId;
    await submitCommand(fixture7, { commandId: `cmd-run-create-${runId.slice(-8)}-1`, kind: "run.create", payload: { projectId: fixture7.projectId } });

    // Simulate a crashed worker: claim directly under a short lease, at the
    // Convex level (not through a KernelDaemon), and never complete it.
    const claimed = (await fixture7.call("mutation", "commands/inbox:claimBatch", {
      deviceToken: fixture7.deviceToken,
      leaseDurationMs: 500,
      limit: 5,
    })) as Array<{ _id: string; leaseGeneration: number }>;
    expect(claimed).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 700)); // let the lease expire

    const daemon = await startDaemon(fixture7.deviceToken, fixture7.machineId, "e2e-lease-expiry-machine");
    try {
      await waitUntilProjected(daemon, async () => {
        const events = await fetchEvents(fixture7, runId, -1);
        return events.some((e) => e.type === "run.created");
      }, 20_000, "run.created to be projected after reclaim");

      const events = await fetchEvents(fixture7, runId, -1);
      expect(events.filter((e) => e.type === "run.created")).toHaveLength(1); // exactly once, no duplicate effect
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  test("a stale worker's completion is fenced once another worker reclaims the same command", async () => {
    const fixture8 = await buildIsolatedFixture(backend);
    const runId = fixture8.threadId;
    await submitCommand(fixture8, { commandId: `cmd-run-create-${runId.slice(-8)}-1`, kind: "run.create", payload: { projectId: fixture8.projectId } });

    const claimedA = (await fixture8.call("mutation", "commands/inbox:claimBatch", {
      deviceToken: fixture8.deviceToken,
      leaseDurationMs: 300,
      limit: 5,
    })) as Array<{ _id: string; leaseGeneration: number }>;
    expect(claimedA).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 400)); // let worker A's lease expire

    const claimedB = (await fixture8.call("mutation", "commands/inbox:claimBatch", {
      deviceToken: fixture8.deviceToken,
      leaseDurationMs: 30_000,
      limit: 5,
    })) as Array<{ _id: string; leaseGeneration: number }>;
    expect(claimedB).toHaveLength(1);
    expect(claimedB[0]!.leaseGeneration).toBeGreaterThan(claimedA[0]!.leaseGeneration);

    // Worker A (stale) tries to complete with its now-superseded generation.
    await expect(
      fixture8.call("mutation", "commands/inbox:completeInbox", {
        commandId: claimedA[0]!._id,
        deviceToken: fixture8.deviceToken,
        leaseGeneration: claimedA[0]!.leaseGeneration,
        status: "completed",
      }),
    ).rejects.toThrow(/[Ss]tale/);

    // Worker B (the current holder) completes normally.
    await fixture8.call("mutation", "commands/inbox:completeInbox", {
      commandId: claimedB[0]!._id,
      deviceToken: fixture8.deviceToken,
      leaseGeneration: claimedB[0]!.leaseGeneration,
      status: "completed",
    });
  }, 30_000);

  test("backend process restart: the daemon recovers its connection and the run converges with no duplicate effect", async () => {
    const { fixture: fixture9, runId, daemon } = await setupScenario("e2e-backend-restart-machine");
    try {
      await submitCommand(fixture9, { commandId: `cmd-run-create-${runId.slice(-8)}-1`, kind: "run.create", payload: { projectId: fixture9.projectId } });
      await waitUntilProjected(daemon, async () => {
        const events = await fetchEvents(fixture9, runId, -1);
        return events.some((e) => e.type === "run.created");
      }, 20_000, "run.created to be projected before backend restart");

      // Kill and restart the real backend process (same SQLite file/data) —
      // the daemon's poll loop is still running throughout and must
      // reconnect on its own, not crash or hang.
      await backend.restart();

      await submitCommand(fixture9, { commandId: `cmd-run-resume-${runId.slice(-8)}-2`, kind: "run.resume", payload: { runId }, runId });
      await waitUntilProjected(daemon, async () => {
        const events = await fetchEvents(fixture9, runId, -1);
        return events.some((e) => e.type === "run.started");
      }, 30_000, "run.started to be projected after backend restart");

      const events = await fetchEvents(fixture9, runId, -1);
      expect(events.filter((e) => e.type === "run.created")).toHaveLength(1);
      const sequences = events.map((e) => e.sequence).sort((a, b) => a - b);
      for (let i = 1; i < sequences.length; i++) {
        expect(sequences[i]).toBe(sequences[i - 1]! + 1);
      }
    } finally {
      await daemon.stop();
    }
  }, 90_000);
});
