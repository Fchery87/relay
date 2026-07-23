// ---------------------------------------------------------------------------
// Cross-tier recovery seam — exercises a real client command through a real
// isolated self-hosted Convex backend and a real KernelDaemon, then through
// ordered projections to a reconnecting client. No convex-test simulator
// and no fake command gateway/projection sink: this is the actual
// createConvexCommandSource/createConvexProjectionSink production code
// talking over HTTP to a real (but throwaway, isolated) backend process.
//
// Skips automatically when the self-hosted Convex backend binary isn't
// installed (see docs/operations/self-hosted-convex.md) — "protected job"
// tier per tickets.md, not part of the ordinary fast/deterministic suite.
// Never touches the developer's real backend or its data — see
// scripts/lib/isolated-self-hosted-convex.ts.
//
// Run explicitly with: bun test apps/daemon/src/cross-tier-recovery.e2e.test.ts
// ---------------------------------------------------------------------------

import { mkdtemp, rm } from "node:fs/promises";
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

const repoRoot = join(import.meta.dir, "..", "..", "..");
const binaryAvailable = (await findSelfHostedBackendBinary()) !== null;

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

async function fetchEvents(fixture: IsolatedFixture, runId: string, afterSequence: number): Promise<Array<{ sequence: number; type: string }>> {
  return fixture.call("query", "projections/publish:listRunEvents", { runId, afterSequence, limit: 200 }, true) as Promise<Array<{ sequence: number; type: string }>>;
}

describe.skipIf(!binaryAvailable)("cross-tier recovery seam (live isolated backend)", () => {
  let backend: IsolatedConvexBackend;
  let fixture: IsolatedFixture;
  const daemonHomes: string[] = [];

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
    await backend?.stop();
  });

  async function tempDaemonHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "relay-e2e-daemon-home-"));
    daemonHomes.push(dir);
    return dir;
  }

  test("create -> resume -> send -> projection landing -> reconnecting client sees ordered events, no gaps", async () => {
    const runId = fixture.threadId; // canonical run ID defaults to threadId when omitted

    // 1. A real daemon, pointed at the real isolated backend, using the
    // real command gateway and projection sink (no fakes/overrides).
    const daemon = new KernelDaemon({
      daemonHome: await tempDaemonHome(),
      deploymentUrl: backend.url,
      deviceToken: fixture.deviceToken,
      heartbeatIntervalMs: 300,
      machineId: fixture.machineId,
      machineName: "e2e-test-machine",
      pollIntervalMs: 200,
    });
    await daemon.start();

    try {
      // 2. Submit commands the way the browser will once cut over (see
      // apps/web/src/run-data.ts's submitCanonicalCommand/canonicalCommandId,
      // not yet wired to a caller — this test proves the seam ahead of that
      // cutover).
      await fixture.call("mutation", "commands/inbox:submitToInbox", {
        commandId: `cmd-run-create-${runId.slice(-8)}-1`,
        correlationId: `corr-${runId}`,
        kind: "run.create",
        payloadJson: JSON.stringify({ projectId: fixture.projectId }),
        threadId: fixture.threadId,
      }, true);

      await fixture.call("mutation", "commands/inbox:submitToInbox", {
        commandId: `cmd-run-resume-${runId.slice(-8)}-2`,
        correlationId: `corr-${runId}`,
        kind: "run.resume",
        payloadJson: JSON.stringify({ runId }),
        runId,
        threadId: fixture.threadId,
      }, true);

      await fixture.call("mutation", "commands/inbox:submitToInbox", {
        commandId: `cmd-turn-send-${runId.slice(-8)}-3`,
        correlationId: `corr-${runId}`,
        kind: "turn.send",
        payloadJson: JSON.stringify({ runId, prompt: "hello from the cross-tier recovery test" }),
        runId,
        threadId: fixture.threadId,
      }, true);

      // 3. Wait on real conditions (receipts landing as projected events),
      // not arbitrary sleeps.
      await waitUntilProjected(daemon, async () => {
        const events = await fetchEvents(fixture, runId, -1);
        return events.some((e) => e.type === "turn.completed" || e.type === "turn.failed");
      }, 20_000, "turn to complete and its terminal event to be projected");

      // 4. The projection landed with a contiguous, ordered event stream —
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

      // 5. Snapshot never leads the confirmed event prefix.
      const snapshot = await fetchSnapshot(fixture, runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.sequence).toBeLessThanOrEqual(sequences[sequences.length - 1]!);

      // 6. A reconnecting client resumes from any confirmed cursor without
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
    await fixture2.call("mutation", "commands/inbox:submitToInbox", {
      commandId: `cmd-run-create-${runId.slice(-8)}-1`,
      correlationId: `corr-${runId}`,
      kind: "run.create",
      payloadJson: JSON.stringify({ projectId: fixture2.projectId }),
      threadId: fixture2.threadId,
    }, true);

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
      await fixture2.call("mutation", "commands/inbox:submitToInbox", {
        commandId: `cmd-run-resume-${runId.slice(-8)}-2`,
        correlationId: `corr-${runId}`,
        kind: "run.resume",
        payloadJson: JSON.stringify({ runId }),
        runId,
        threadId: fixture2.threadId,
      }, true);

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
});
