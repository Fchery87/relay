import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { HarnessRuntime } from "./harness-runtime";
import { FakeHarnessRuntime } from "./fake-harness-runtime";
import { LocalHarnessRuntime } from "./local-harness-runtime";
import { runHarnessRuntimeContract } from "./harness-runtime.contract";
import { createDeterministicProviderReactor } from "@relay/orchestration";

// ---------------------------------------------------------------------------
// Conformance suite — runs against any HarnessRuntime implementation.
// Every test is a contract the runtime must satisfy.
// ---------------------------------------------------------------------------

test("shared black-box contract passes the fake runtime without provider failure", async () => {
  await runHarnessRuntimeContract("fake-ok", () => ({ runtime: new FakeHarnessRuntime() }));
});

test("shared black-box contract passes the fake runtime with provider failure", async () => {
  const rt = new FakeHarnessRuntime({ scriptedEvents: [], providerFails: true });
  await runHarnessRuntimeContract("fake-fail", () => ({ runtime: rt, providerFails: true }));
});

test("shared black-box contract passes the local runtime", async () => {
  const runtime = LocalHarnessRuntime.memory({ reactors: { "provider.send_turn": createDeterministicProviderReactor({ text: "contract" }) } });
  await runHarnessRuntimeContract("local", () => ({ runtime, drain: async () => { await runtime.drainEffects(); }, close: () => runtime.shutdown() }));
}, { timeout: 30000 });

// ---------------------------------------------------------------------------
// Additional conformance beyond the shared contract — run isolation,
// two-run snapshot independence, and local-only restart/recovery.
// ---------------------------------------------------------------------------

test("creating two runs produces independent snapshots", async () => {
  const rt = new FakeHarnessRuntime();
  const a = await rt.createRun({ projectId: "a" });
  const b = await rt.createRun({ projectId: "b" });
  expect(a.runId).not.toBe(b.runId);
  const sa = await rt.snapshot({ runId: a.runId });
  const sb = await rt.snapshot({ runId: b.runId });
  expect(sa.status).toBe("ready");
  expect(sb.status).toBe("ready");
});

test("local runtime restart replays to the persisted snapshot", async () => {
  const dir = mkdtempSync(join("/tmp", "relay-contract-restart-"));
  const path = join(dir, "restart.sqlite");
  const reactors = { "provider.send_turn": createDeterministicProviderReactor({ text: "restart" }) };
  const a = LocalHarnessRuntime.open(path, { reactors });
  const created = await a.createRun({ projectId: "restart" });
  await a.resumeRun({ runId: created.runId });
  await a.sendTurn({ runId: created.runId, prompt: "pre-restart" });
  await a.drainEffects();
  const snapBefore = await a.snapshot({ runId: created.runId });
  await a.shutdown();

  const b = LocalHarnessRuntime.open(path);
  const snapAfter = b.getSnapshotByRunId(created.runId);
  expect(snapAfter).toBeDefined();
  expect(snapAfter!.runId).toBe(created.runId);
  expect(snapAfter!.sequence).toBeGreaterThanOrEqual(snapBefore.sequence);
  b.shutdown();
});
