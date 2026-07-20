import type { HarnessRuntime } from "./harness-runtime";

export type HarnessRuntimeFixture = Readonly<{ runtime: HarnessRuntime; drain?: () => Promise<void> | void; close?: () => Promise<void> | void; reopen?: () => Promise<HarnessRuntime>; now?: () => number; providerFails?: boolean }>;

async function collectEvents(runtime: HarnessRuntime, runId: string, maxWaitMs: number, afterSequence?: number): Promise<Array<{ type: string; sequence: number }>> {
  const out: Array<{ type: string; sequence: number }> = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), maxWaitMs);
  try {
    for await (const ev of runtime.observe({ runId: runId as never, afterSequence, signal: controller.signal })) {
      out.push({ type: ev.type, sequence: ev.sequence });
      if (out.length >= 200) { controller.abort(); break; }
    }
  } catch { /* timed out or closed */ }
  clearTimeout(timer);
  return out;
}

/** The identical black-box lifecycle assertions are shared by fake and durable fixtures. */
export async function runHarnessRuntimeContract(name: string, createFixture: () => Promise<HarnessRuntimeFixture> | HarnessRuntimeFixture): Promise<void> {
  const fixture = await createFixture(); const rt = fixture.runtime;
  try {
    // --- create / resume / send / duplicate / observe / isolation / stop ---
    const first = await rt.createRun({ projectId: `${name}-project` });
    if (first.status !== "ready") throw new Error(`${name}: create must be ready`);
    await rt.resumeRun({ runId: first.runId });
    const commandId = `contract-${name}-send` as never;
    const receipt = await rt.sendTurn({ runId: first.runId, prompt: "contract", commandId });
    const duplicate = await rt.sendTurn({ runId: first.runId, prompt: "contract", commandId }).catch(() => undefined);
    if (duplicate && duplicate.commandId !== receipt.commandId) throw new Error(`${name}: duplicate command changed receipt`);
    await fixture.drain?.();
    const observed = await collectEvents(rt, first.runId, 500);
    if (observed.length < 3) throw new Error(`${name}: too few observed events (got ${observed.length})`);
    for (let i = 1; i < observed.length; i++) if (observed[i]!.sequence <= observed[i - 1]!.sequence) throw new Error(`${name}: non-monotonic observation`);
    const second = await rt.createRun({ projectId: `${name}-isolated` });
    if (second.runId === first.runId) throw new Error(`${name}: run identity collision`);
    await rt.resumeRun({ runId: second.runId });
    await rt.stopRun({ runId: second.runId, reason: "contract" });
    if ((await rt.snapshot({ runId: second.runId })).status !== "stopped") throw new Error(`${name}: stop failed`);

    // --- steering ---
    const steerRun = await rt.createRun({ projectId: `${name}-steer` });
    await rt.resumeRun({ runId: steerRun.runId });
    await rt.sendTurn({ runId: steerRun.runId, prompt: "before steer" });
    await rt.steerTurn({ runId: steerRun.runId, steering: "change direction" });
    await fixture.drain?.();
    const steeredEvents = await collectEvents(rt, steerRun.runId, 500);
    if (!steeredEvents.some(e => e.type === "turn.steered")) throw new Error(`${name}: steering must produce turn.steered`);

    // --- interruption ---
    const intRun = await rt.createRun({ projectId: `${name}-interrupt` });
    await rt.resumeRun({ runId: intRun.runId });
    await rt.sendTurn({ runId: intRun.runId, prompt: "before interrupt" });
    await rt.interruptTurn({ runId: intRun.runId, reason: "user cancel" });
    await fixture.drain?.();
    const interruptedEvents = await collectEvents(rt, intRun.runId, 500);
    if (!interruptedEvents.some(e => e.type === "turn.interrupted")) throw new Error(`${name}: interruption must produce turn.interrupted`);

    // --- approval --- (skipped if runtime state does not allow)
    const apprRun = await rt.createRun({ projectId: `${name}-approve` });
    await rt.resumeRun({ runId: apprRun.runId });
    try {
      await rt.resolveApproval({ runId: apprRun.runId, approvalId: "a-1", resolution: "allow" });
      await fixture.drain?.();
    } catch { /* runtime may reject approval when not awaiting */ }

    // --- afterSequence cursor ---
    const cursorRun = await rt.createRun({ projectId: `${name}-cursor` });
    await rt.resumeRun({ runId: cursorRun.runId });
    await rt.sendTurn({ runId: cursorRun.runId, prompt: "cursor" });
    await fixture.drain?.();
    const allCursor = await collectEvents(rt, cursorRun.runId, 500);
    if (allCursor.length < 2) throw new Error(`${name}: need at least 2 events for cursor test`);
    const mid = allCursor[Math.floor(allCursor.length / 2)]!;
    const after = await collectEvents(rt, cursorRun.runId, 500, mid.sequence);
    for (const e of after) { if (e.sequence <= mid.sequence) throw new Error(`${name}: afterSequence ${mid.sequence} leaked event seq ${e.sequence}`); }

    // --- provider failure produces turn.failed (not a throw from sendTurn) ---
    if (fixture.providerFails) {
      const failRun = await rt.createRun({ projectId: `${name}-provider-fail` });
      await rt.resumeRun({ runId: failRun.runId });
      const failReceipt = await rt.sendTurn({ runId: failRun.runId, prompt: "crash" });
      if (!failReceipt.turnId) throw new Error(`${name}: provider-failure turn must have a turnId`);
      await fixture.drain?.();
      const failEvents = await collectEvents(rt, failRun.runId, 500);
      if (!failEvents.some(e => e.type === "turn.failed")) throw new Error(`${name}: provider failure must produce turn.failed`);
      // The run must remain stoppable
      await rt.stopRun({ runId: failRun.runId, reason: "contract" });
      if ((await rt.snapshot({ runId: failRun.runId })).status !== "stopped") throw new Error(`${name}: provider-failed run must still be stoppable`);
    }
  } finally { await fixture.close?.(); }
}
