import type { RunSnapshot, EventEnvelope, CanonicalEventType } from "@relay/contracts";
import { openMemoryStore, openStore, getSnapshot, getEventsAfter, insertSnapshot, appendEvents } from "@relay/local-store";
import type { StoreDatabase } from "@relay/local-store";
import { OrchestrationEngine } from "@relay/orchestration";
import {
  type HarnessRuntime,
  type CreateRunInput,
  type ResumeRunInput,
  type SendTurnInput,
  type SteerTurnInput,
  type InterruptTurnInput,
  type ResolveApprovalInput,
  type StopRunInput,
  type SnapshotInput,
  type ObserveInput,
  type TurnReceipt,
} from "./harness-runtime";

export class LocalHarnessRuntime implements HarnessRuntime {
  private readonly engine: OrchestrationEngine;

  constructor(
    private readonly db: StoreDatabase,
    config?: { maxConcurrentRuns?: number },
  ) {
    this.engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: config?.maxConcurrentRuns ?? 4,
    });
  }

  /** Open a persistent file-backed runtime. */
  static open(path: string, config?: { maxConcurrentRuns?: number }): LocalHarnessRuntime {
    return new LocalHarnessRuntime(openStore(path), config);
  }

  /** Open an in-memory runtime (for tests). */
  static memory(config?: { maxConcurrentRuns?: number }): LocalHarnessRuntime {
    return new LocalHarnessRuntime(openMemoryStore(), config);
  }

  // -- HarnessRuntime impl ---------------------------------------------------

  async createRun(input: CreateRunInput): Promise<RunSnapshot> {
    const snapshot = this.engine.createRunSnapshot(input.projectId);

    const result = appendEvents(this.db, {
      runId: snapshot.runId as string,
      commandId: `cmd-create-${snapshot.runId}`,
      events: [
        {
          eventId: `ev-create-${snapshot.runId}`,
          type: "run.created",
          payload: { environmentId: "local", projectId: input.projectId },
          correlationId: `corr-create-${snapshot.runId}`,
        },
      ],
    });

    if (!result.ok) throw new Error(`createRun failed: ${result.reason}`);

    // Move to ready
    updateStatus(this.db, snapshot.runId as string, "ready");
    const ready = getSnapshot(this.db, snapshot.runId as string);
    return ready ?? result.snapshot;
  }

  async resumeRun(input: ResumeRunInput): Promise<RunSnapshot> {
    return this.engine.submit({
      commandId: `cmd-resume-${input.runId}` as never,
      type: "run.resume",
      runId: input.runId,
      correlationId: `corr-resume` as never,
      actor: { kind: "system", id: "harness" },
      issuedAt: Date.now(),
      payload: {},
    });
  }

  async sendTurn(input: SendTurnInput): Promise<TurnReceipt> {
    const commandId = `cmd-send-${crypto.randomUUID()}`;

    // Simulate provider producing assistant output
    const snap = await this.engine.submit({
      commandId: commandId as never,
      type: "turn.send",
      runId: input.runId,
      correlationId: `corr-send` as never,
      actor: { kind: "user", id: "user" },
      issuedAt: Date.now(),
      payload: { prompt: input.prompt },
    });

    // Emit assistant response events
    appendEvents(this.db, {
      runId: input.runId as string,
      commandId: `cmd-assistant-${commandId}`,
      events: [
        {
          eventId: `ev-delta-${commandId}`,
          type: "assistant.delta",
          payload: { text: "Harness reply to: " + input.prompt.substring(0, 50) },
          correlationId: `corr-send`,
        },
        {
          eventId: `ev-comp-${commandId}`,
          type: "assistant.completed",
          payload: {},
          correlationId: `corr-send`,
        },
        {
          eventId: `ev-turn-done-${commandId}`,
          type: "turn.completed",
          payload: {},
          correlationId: `corr-send`,
        },
      ],
    });

    return { turnId: `turn-${commandId}` as never, commandId: commandId as never };
  }

  async steerTurn(input: SteerTurnInput): Promise<void> {
    await this.engine.submit({
      commandId: `cmd-steer-${crypto.randomUUID()}` as never,
      type: "turn.steer",
      runId: input.runId,
      correlationId: `corr-steer` as never,
      actor: { kind: "user", id: "user" },
      issuedAt: Date.now(),
      payload: { steering: input.steering },
    });
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    await this.engine.submit({
      commandId: `cmd-interrupt-${crypto.randomUUID()}` as never,
      type: "turn.interrupt",
      runId: input.runId,
      correlationId: `corr-int` as never,
      actor: { kind: "user", id: "user" },
      issuedAt: Date.now(),
      payload: { reason: input.reason ?? "user" },
    });
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<void> {
    await this.engine.submit({
      commandId: `cmd-approve-${crypto.randomUUID()}` as never,
      type: "approval.resolve",
      runId: input.runId,
      correlationId: `corr-approve` as never,
      actor: { kind: "user", id: "user" },
      issuedAt: Date.now(),
      payload: { approvalId: input.approvalId, resolution: input.resolution },
    });
  }

  async stopRun(input: StopRunInput): Promise<void> {
    await this.engine.submit({
      commandId: `cmd-stop-${crypto.randomUUID()}` as never,
      type: "run.stop",
      runId: input.runId,
      correlationId: `corr-stop` as never,
      actor: { kind: "user", id: "user" },
      issuedAt: Date.now(),
      payload: { reason: input.reason ?? "user" },
    });
  }

  async snapshot(input: SnapshotInput): Promise<RunSnapshot> {
    const snap = getSnapshot(this.db, input.runId as string);
    if (!snap) throw new Error(`Run not found: ${input.runId}`);
    return snap;
  }

  async *observe(input: ObserveInput): AsyncIterable<EventEnvelope<CanonicalEventType, unknown>> {
    const after = input.afterSequence ?? -1;
    const events = getEventsAfter(this.db, input.runId as string, after);
    for (const ev of events) {
      yield ev;
    }
  }

  /** Close the underlying database connection (if file-backed). */
  close(): void {
    this.db.close();
  }
}

function updateStatus(db: StoreDatabase, runId: string, status: string): void {
  db.run("UPDATE run_snapshots SET status = ?, updated_at = ? WHERE run_id = ?", [
    status,
    Date.now(),
    runId,
  ]);
}
