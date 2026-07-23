import { describe, expect, test } from "bun:test";
import type { ReactorCommandDraft } from "@relay/contracts";
import {
  appendEvents,
  claimEffectBatch,
  getEffectsForCommand,
  getEventsAfter,
  getSnapshot,
  openMemoryStore,
} from "@relay/local-store";
import { OrchestrationEngine } from "./orchestration-engine";
import { createDeterministicProviderReactor } from "./fake-provider-reactor";

describe("OrchestrationEngine durability", () => {
  test("executes twenty run effects with at most four active reactors", async () => {
    const db = openMemoryStore();
    let active = 0;
    let maximumActive = 0;
    const deterministic = createDeterministicProviderReactor({ text: "done" });
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 4,
      reactorBatchSize: 20,
      reactors: {
        "provider.send_turn": {
          execute: async (effect, context) => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            await Promise.resolve();
            try {
              return await deterministic.execute(effect, context);
            } finally {
              active--;
            }
          },
          recover: deterministic.recover,
        },
      },
    });

    for (let index = 0; index < 20; index++) {
      const created = await engine.createRun({ projectId: `project-${index}` });
      await engine.submit({
        commandId: `cmd-resume-concurrency-${index}` as never,
        type: "run.resume",
        runId: created.runId,
        correlationId: `corr-resume-concurrency-${index}` as never,
        actor: { kind: "system", id: "test" },
        issuedAt: index * 2,
        payload: {},
      });
      await engine.submit({
        commandId: `cmd-turn-concurrency-${index}` as never,
        type: "turn.send",
        runId: created.runId,
        correlationId: `corr-turn-concurrency-${index}` as never,
        actor: { kind: "user", id: "test" },
        issuedAt: index * 2 + 1,
        payload: {
          prompt: `turn ${index}`,
          turnId: `turn-concurrency-${index}` as never,
        },
      });
    }

    expect(await engine.drainEffects()).toBe(20);
    expect(maximumActive).toBe(4);
  });

  test("serializes concurrent drain calls on one engine", async () => {
    const db = openMemoryStore();
    let started!: () => void;
    let release!: () => void;
    const reactorStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const reactorRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executions = 0;
    const deterministic = createDeterministicProviderReactor({ text: "done" });
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactors: {
        "provider.send_turn": {
          execute: async (effect, context) => {
            executions++;
            started();
            await reactorRelease;
            return deterministic.execute(effect, context);
          },
          recover: deterministic.recover,
        },
      },
    });
    const created = await engine.createRun({ projectId: "project-1" });
    await engine.submit({
      commandId: "cmd-resume-concurrent-drain" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-concurrent-drain" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 1,
      payload: {},
    });
    await engine.submit({
      commandId: "cmd-turn-concurrent-drain" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-concurrent-drain" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 2,
      payload: { prompt: "hello", turnId: "turn-concurrent-drain" as never },
    });

    const first = engine.drainEffects();
    await reactorStarted;
    const second = engine.drainEffects();
    release();

    expect(await Promise.all([first, second])).toEqual([1, 0]);
    expect(executions).toBe(1);
  });

  test("control drain reaches an in-flight provider turn", async () => {
    const db = openMemoryStore();
    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    let steeringSeen = false;
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactors: {
        "provider.send_turn": {
          execute: async (effect, context) => {
            providerStarted();
            await providerGate;
            return createDeterministicProviderReactor({ text: "done" }).execute(effect, context);
          },
          recover: async () => [],
        },
        "provider.steer_turn": {
          execute: async () => {
            steeringSeen = true;
            return [];
          },
          recover: async () => [],
        },
      },
    });
    const created = await engine.createRun({ projectId: "project-control" });
    await engine.submit({
      commandId: "cmd-resume-control" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-control" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 1,
      payload: {},
    });
    await engine.submit({
      commandId: "cmd-turn-control" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-control" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 2,
      payload: { prompt: "hello", turnId: "turn-control" as never },
    });
    const providerDrain = engine.drainEffects();
    await started;
    await engine.submit({
      commandId: "cmd-steer-control" as never,
      type: "turn.steer",
      runId: created.runId,
      correlationId: "corr-steer-control" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 3,
      payload: { steering: "focus" },
    });

    expect(await engine.drainControlEffects()).toBe(1);
    expect(steeringSeen).toBe(true);
    releaseProvider();
    await providerDrain;
  });

  test("runs a follow-up pass when an effect arrives during a bounded drain", async () => {
    const db = openMemoryStore();
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let executions = 0;
    const deterministic = createDeterministicProviderReactor({ text: "done" });
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 2,
      reactorBatchSize: 1,
      reactors: {
        "provider.send_turn": {
          execute: async (effect, context) => {
            executions++;
            if (executions === 1) {
              firstStarted();
              await release;
            }
            return deterministic.execute(effect, context);
          },
          recover: deterministic.recover,
        },
      },
    });

    const submitTurn = async (suffix: string) => {
      const created = await engine.createRun({ projectId: `project-${suffix}` });
      await engine.submit({
        commandId: `cmd-resume-${suffix}` as never,
        type: "run.resume",
        runId: created.runId,
        correlationId: `corr-resume-${suffix}` as never,
        actor: { kind: "system", id: "test" },
        issuedAt: 1,
        payload: {},
      });
      await engine.submit({
        commandId: `cmd-turn-${suffix}` as never,
        type: "turn.send",
        runId: created.runId,
        correlationId: `corr-turn-${suffix}` as never,
        actor: { kind: "user", id: "test" },
        issuedAt: 2,
        payload: {
          prompt: suffix,
          turnId: `turn-${suffix}` as never,
        },
      });
    };

    await submitTurn("first");
    const firstDrain = engine.drainEffects();
    await started;
    await submitTurn("second");
    const followUpDrain = engine.drainEffects();
    releaseFirst();

    expect(await Promise.all([firstDrain, followUpDrain])).toEqual([1, 1]);
    expect(executions).toBe(2);
    expect(
      getEffectsForCommand(db, "cmd-turn-second" as never)[0],
    ).toMatchObject({ status: "completed" });
  });

  test("does not lose a drain requested during promise settlement", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactors: {
        "workspace.create": {
          execute: async () => [{
            type: "workspace.result",
            payload: { kind: "created", result: {} },
          }],
          recover: async () => [{
            type: "workspace.result",
            payload: { kind: "created", result: {} },
          }],
        },
      },
    });
    const created = await engine.createRun({ projectId: "project-settlement" });

    const emptyDrain = engine.drainEffects();
    let followUpDrain!: Promise<number>;
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        appendEvents(db, {
          runId: created.runId,
          commandId: "cmd-workspace-settlement" as never,
          nextSnapshot: created,
          events: [],
          effects: [{
            effectId: "effect-workspace-settlement" as never,
            runId: created.runId,
            commandId: "cmd-workspace-settlement" as never,
            effectIndex: 0,
            intent: {
              kind: "workspace.create",
              repoPath: "/tmp/relay-settlement",
            },
            retryClass: "transient",
          }],
        });
        followUpDrain = engine.drainEffects();
        resolve();
      });
    });

    expect(await Promise.all([emptyDrain, followUpDrain])).toEqual([0, 1]);
    expect(
      getEffectsForCommand(db, "cmd-workspace-settlement" as never)[0],
    ).toMatchObject({ status: "completed", attempts: 1 });
  });

  test("an expired retryable lease reconciles without executing twice", async () => {
    const db = openMemoryStore();
    const setupEngine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });
    const created = await setupEngine.createRun({ projectId: "project-1" });
    await setupEngine.submit({
      commandId: "cmd-resume-recovery" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-recovery" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 1,
      payload: {},
    });
    await setupEngine.submit({
      commandId: "cmd-turn-recovery" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-recovery" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 2,
      payload: { prompt: "recover", turnId: "turn-recovery" as never },
    });
    expect(claimEffectBatch(db, "crashed-worker", 1, 1, 1)).toHaveLength(1);

    let executions = 0;
    let recoveries = 0;
    const deterministic = createDeterministicProviderReactor({
      text: "reconciled",
    });
    const recoveryEngine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactors: {
        "provider.send_turn": {
          execute: async (effect, context) => {
            executions++;
            return deterministic.execute(effect, context);
          },
          recover: async (effect, context) => {
            recoveries++;
            return deterministic.recover(effect, context);
          },
        },
      },
    });

    expect(await recoveryEngine.drainEffects()).toBe(1);
    expect(executions).toBe(0);
    expect(recoveries).toBe(1);
    expect(
      getEffectsForCommand(db, "cmd-turn-recovery" as never)[0],
    ).toMatchObject({ status: "completed", attempts: 2 });
  });

  test("a reclaimed lease fences stale reactor results before persistence", async () => {
    const db = openMemoryStore();
    const deterministic = createDeterministicProviderReactor({ text: "stale" });
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactorLeaseMs: 1_000,
      reactors: {
        "provider.send_turn": {
          execute: async (effect, context) => {
            expect(
              claimEffectBatch(
                db,
                "replacement-worker",
                1_000,
                1,
                Date.now() + 2_000,
              ),
            ).toHaveLength(1);
            return deterministic.execute(effect, context);
          },
          recover: deterministic.recover,
        },
      },
    });
    const created = await engine.createRun({ projectId: "project-stale" });
    await engine.submit({
      commandId: "cmd-resume-stale" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-stale" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 1,
      payload: {},
    });
    await engine.submit({
      commandId: "cmd-turn-stale" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-stale" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 2,
      payload: { prompt: "hello", turnId: "turn-stale" as never },
    });

    expect(await engine.drainEffects()).toBe(0);
    expect(
      getEffectsForCommand(db, "cmd-turn-stale" as never)[0],
    ).toMatchObject({
      status: "running",
      attempts: 2,
      leaseOwner: "replacement-worker",
    });
    expect(
      getEventsAfter(db, created.runId, -1).filter(
        (event) =>
          event.type === "assistant.delta" ||
          event.type === "assistant.completed" ||
          event.type === "turn.completed",
      ),
    ).toHaveLength(0);
  });

  test("recovery result identity does not collide with a partially persisted execute batch", async () => {
    const db = openMemoryStore();
    const setupEngine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });
    const created = await setupEngine.createRun({ projectId: "project-partial" });
    await setupEngine.submit({
      commandId: "cmd-resume-partial" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-partial" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 1,
      payload: {},
    });
    await setupEngine.submit({
      commandId: "cmd-turn-partial" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-partial" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 2,
      payload: { prompt: "hello", turnId: "turn-partial" as never },
    });
    const [effect] = getEffectsForCommand(
      db,
      "cmd-turn-partial" as never,
    );
    if (!effect) throw new Error("expected provider effect");
    expect(claimEffectBatch(db, "crashed-worker", 1, 1, 1)).toHaveLength(1);

    const providerInstanceId = "provider-partial" as never;
    await setupEngine.submit({
      commandId:
        `cmd-result-${effect.effectId}-provider-ev-partial-delta` as never,
      type: "provider.event",
      runId: created.runId,
      correlationId: "corr-partial-delta" as never,
      causationId: effect.commandId as never,
      actor: { kind: "system", id: "reactor" },
      issuedAt: 3,
      payload: {
        providerInstanceId,
        normalizedEvent: {
          eventId: "ev-partial-delta" as never,
          type: "assistant.delta",
          turnId: "turn-partial" as never,
          providerInstanceId,
          correlationId: "corr-partial-delta" as never,
          causationId: effect.commandId as never,
          payload: { text: "partial" },
        },
      },
    });

    const recoveryEngine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactors: {
        "provider.send_turn": {
          execute: async () => {
            throw new Error("expired effect must recover");
          },
          recover: async () => [{
            type: "provider.event",
            payload: {
              providerInstanceId,
              normalizedEvent: {
                eventId: "ev-partial-terminal" as never,
                type: "turn.completed",
                turnId: "turn-partial" as never,
                providerInstanceId,
                correlationId: "corr-partial-terminal" as never,
                causationId: effect.commandId as never,
                payload: { summary: "recovered" },
              },
            },
          }],
        },
      },
    });

    expect(await recoveryEngine.drainEffects()).toBe(1);
    expect(
      getEffectsForCommand(db, "cmd-turn-partial" as never)[0],
    ).toMatchObject({ status: "completed", attempts: 2 });
    expect(getSnapshot(db, created.runId)?.activeTurnId).toBeUndefined();
    expect(
      getEventsAfter(db, created.runId, -1).filter(
        (event) => event.turnId === "turn-partial",
      ).map((event) => event.type),
    ).toEqual(["turn.started", "assistant.delta", "turn.completed"]);
  });

  test("completes provider acceptance before a queued live steering effect", async () => {
    const db = openMemoryStore();
    const acceptedKinds: string[] = [];
    const accept = async (effect: Parameters<
      ReturnType<typeof createDeterministicProviderReactor>["execute"]
    >[0]) => {
      acceptedKinds.push(effect.intent.kind);
      return [];
    };
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactors: {
        "provider.send_turn": {
          execute: accept,
          recover: accept,
        },
        "provider.steer_turn": {
          execute: accept,
          recover: accept,
        },
      },
    });
    const created = await engine.createRun({ projectId: "project-1" });
    await engine.submit({
      commandId: "cmd-resume-incomplete" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-incomplete" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 1,
      payload: {},
    });
    await engine.submit({
      commandId: "cmd-turn-incomplete" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-incomplete" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 2,
      payload: { prompt: "hello", turnId: "turn-incomplete" as never },
    });
    await engine.submit({
      commandId: "cmd-steer-incomplete" as never,
      type: "turn.steer",
      runId: created.runId,
      correlationId: "corr-steer-incomplete" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 3,
      payload: { steering: "focus" },
    });

    expect(await engine.drainEffects()).toBe(2);
    expect(acceptedKinds).toEqual([
      "provider.send_turn",
      "provider.steer_turn",
    ]);
    expect(
      getEffectsForCommand(db, "cmd-turn-incomplete" as never)[0],
    ).toMatchObject({ status: "completed", attempts: 1 });
    expect(getSnapshot(db, created.runId)?.activeTurnId).toBe(
      "turn-incomplete" as never,
    );
  });

  test("does not report checkpoint restore success without a matching result", async () => {
    const db = openMemoryStore();
    const emptyResult = async () => [];
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactorMaxAttempts: 1,
      reactors: {
        "checkpoint.restore": {
          execute: emptyResult,
          recover: emptyResult,
        },
      },
    });
    const created = await engine.createRun({ projectId: "project-1" });
    await engine.submit({
      commandId: "cmd-checkpoint-without-result" as never,
      type: "checkpoint.restore",
      runId: created.runId,
      correlationId: "corr-checkpoint-without-result" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 2,
      payload: { checkpointId: "checkpoint-1" },
    });

    expect(await engine.drainEffects()).toBe(0);
    expect(
      getEventsAfter(db, created.runId, -1).map((event) => event.type),
    ).not.toContain("checkpoint.restored");
    expect(
      getEffectsForCommand(
        db,
        "cmd-checkpoint-without-result" as never,
      )[0],
    ).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining(
        "checkpoint.restore reactor must return exactly one matching checkpoint.result",
      ),
    });
  });

  test("resolves an approval only after the provider accepts the decision", async () => {
    const db = openMemoryStore();
    const accept = async () => [];
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactors: {
        "provider.resolve_approval": {
          execute: accept,
          recover: accept,
        },
      },
    });
    const created = await engine.createRun({ projectId: "project-1" });
    await engine.submit({
      commandId: "cmd-resume-approval" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-approval" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 1,
      payload: {},
    });
    await engine.submit({
      commandId: "cmd-request-approval" as never,
      type: "provider.event",
      runId: created.runId,
      correlationId: "corr-request-approval" as never,
      actor: { kind: "provider", id: "test" },
      issuedAt: 2,
      payload: {
        providerInstanceId: "provider-test" as never,
        normalizedEvent: {
          eventId: "ev-request-approval" as never,
          type: "approval.requested",
          correlationId: "corr-event-request-approval" as never,
          payload: {
            approvalId: "approval-1" as never,
            capability: "exec",
            risk: "high",
            details: "run command",
          },
        },
      },
    });
    await engine.submit({
      commandId: "cmd-resolve-approval" as never,
      type: "approval.resolve",
      runId: created.runId,
      correlationId: "corr-resolve-approval" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 3,
      payload: { approvalId: "approval-1", resolution: "allow" },
    });
    expect(getSnapshot(db, created.runId)).toMatchObject({
      status: "awaiting_approval",
      pendingApprovalId: "approval-1",
    });

    expect(await engine.drainEffects()).toBe(1);
    expect(getSnapshot(db, created.runId)).toMatchObject({
      status: "running",
    });
    expect(getSnapshot(db, created.runId)?.pendingApprovalId).toBeUndefined();
    expect(
      getEventsAfter(db, created.runId, -1).map((event) => event.type),
    ).toContain("approval.resolved");
  });

  test("rejects reactor commands after a terminal turn event", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactorMaxAttempts: 1,
      reactors: {
        "provider.send_turn": {
          execute: async (
            effect,
          ): Promise<ReadonlyArray<ReactorCommandDraft>> => {
            if (effect.intent.kind !== "provider.send_turn") return [];
            const eventBase = {
              turnId: effect.intent.turnId,
              providerInstanceId: "provider-misordered" as never,
              correlationId: "corr-misordered" as never,
              causationId: effect.commandId as never,
            };
            return [
              {
                type: "provider.event",
                payload: {
                  providerInstanceId: "provider-misordered" as never,
                  normalizedEvent: {
                    ...eventBase,
                    eventId: "ev-misordered-terminal" as never,
                    type: "turn.completed",
                    payload: {},
                  },
                },
              },
              {
                type: "provider.event",
                payload: {
                  providerInstanceId: "provider-misordered" as never,
                  normalizedEvent: {
                    ...eventBase,
                    eventId: "ev-misordered-delta" as never,
                    type: "assistant.delta",
                    payload: { text: "late" },
                  },
                },
              },
            ];
          },
          recover: async () => [],
        },
      },
    });
    const created = await engine.createRun({ projectId: "project-misordered" });
    await engine.submit({
      commandId: "cmd-resume-misordered" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-misordered" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 1,
      payload: {},
    });
    await engine.submit({
      commandId: "cmd-turn-misordered" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-misordered" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 2,
      payload: { prompt: "hello", turnId: "turn-misordered" as never },
    });

    expect(await engine.drainEffects()).toBe(0);
    expect(
      getEventsAfter(db, created.runId, -1).filter(
        (event) => event.type === "assistant.delta",
      ),
    ).toHaveLength(0);
    expect(getEventsAfter(db, created.runId, -1).at(-1)).toMatchObject({
      type: "turn.failed",
      turnId: "turn-misordered",
    });
  });

  test("rejects provider results scoped to a different turn", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactorMaxAttempts: 1,
      reactors: {
        "provider.send_turn": {
          execute: async (
            effect,
          ): Promise<ReadonlyArray<ReactorCommandDraft>> => {
            if (effect.intent.kind !== "provider.send_turn") return [];
            const providerInstanceId = "provider-foreign-turn" as never;
            return [
              {
                type: "provider.event",
                payload: {
                  providerInstanceId,
                  normalizedEvent: {
                    eventId: "ev-foreign-delta" as never,
                    type: "assistant.delta",
                    turnId: "turn-foreign" as never,
                    providerInstanceId,
                    correlationId: "corr-foreign-delta" as never,
                    causationId: effect.commandId as never,
                    payload: { text: "wrong turn" },
                  },
                },
              },
              {
                type: "provider.event",
                payload: {
                  providerInstanceId,
                  normalizedEvent: {
                    eventId: "ev-expected-terminal" as never,
                    type: "turn.completed",
                    turnId: effect.intent.turnId,
                    providerInstanceId,
                    correlationId: "corr-expected-terminal" as never,
                    causationId: effect.commandId as never,
                    payload: {},
                  },
                },
              },
            ];
          },
          recover: async () => [],
        },
      },
    });
    const created = await engine.createRun({ projectId: "project-foreign" });
    await engine.submit({
      commandId: "cmd-resume-foreign" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-foreign" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 1,
      payload: {},
    });
    await engine.submit({
      commandId: "cmd-turn-foreign-expected" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-foreign-expected" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 2,
      payload: { prompt: "hello", turnId: "turn-expected" as never },
    });

    expect(await engine.drainEffects()).toBe(0);
    expect(
      getEventsAfter(db, created.runId, -1).filter(
        (event) => event.turnId === "turn-foreign",
      ),
    ).toHaveLength(0);
    expect(getEventsAfter(db, created.runId, -1).at(-1)).toMatchObject({
      type: "turn.failed",
      turnId: "turn-expected",
    });
  });

  test("a completed turn ID cannot be reopened by a later command", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactors: {
        "provider.send_turn": createDeterministicProviderReactor({
          text: "done",
        }),
      },
    });
    const created = await engine.createRun({ projectId: "project-turn-id" });
    await engine.submit({
      commandId: "cmd-resume-turn-id" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-turn-id" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 1,
      payload: {},
    });
    await engine.submit({
      commandId: "cmd-turn-id-first" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-id-first" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 2,
      payload: { prompt: "first", turnId: "turn-reused" as never },
    });
    expect(await engine.drainEffects()).toBe(1);

    await expect(engine.submit({
      commandId: "cmd-turn-id-second" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-id-second" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 3,
      payload: { prompt: "second", turnId: "turn-reused" as never },
    })).rejects.toThrow("Turn ID is already bound to this run");
    expect(
      getEventsAfter(db, created.runId, -1).filter(
        (event) => event.turnId === "turn-reused",
      ).map((event) => event.type),
    ).toEqual([
      "turn.started",
      "assistant.delta",
      "assistant.completed",
      "turn.completed",
    ]);
  });

  test("recovers an expired non-retryable lease without invoking its reactor", async () => {
    const db = openMemoryStore();
    const setupEngine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });
    const created = await setupEngine.createRun({ projectId: "project-1" });
    appendEvents(db, {
      runId: created.runId,
      commandId: "cmd-non-retryable-recovery" as never,
      nextSnapshot: created,
      events: [],
      effects: [{
        effectId: "effect-non-retryable-recovery" as never,
        runId: created.runId,
        commandId: "cmd-non-retryable-recovery" as never,
        effectIndex: 0,
        intent: { kind: "tool.execute", toolName: "test", input: {} },
        retryClass: "never",
      }],
    });
    expect(claimEffectBatch(db, "crashed-worker", 1, 1, 1)).toHaveLength(1);

    let executions = 0;
    const recoveryEngine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactors: {
        "tool.execute": {
          execute: async () => {
            executions++;
            return [];
          },
          recover: async () => {
            executions++;
            return [];
          },
        },
      },
    });
    expect(await recoveryEngine.drainEffects()).toBe(0);
    expect(executions).toBe(0);
    expect(
      getEffectsForCommand(db, "cmd-non-retryable-recovery" as never)[0],
    ).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "Non-retryable effect lease expired",
    });
    expect(
      db.query(
        "SELECT COUNT(*) AS count FROM command_receipts WHERE command_id = ?",
      ).get("cmd-result-effect-non-retryable-recovery-failure"),
    ).toEqual({ count: 1 });
  });

  test("100 concurrent duplicate turn deliveries persist one receipt and one effect", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 4 });
    const created = await engine.createRun({ projectId: "project-1" });
    await engine.submit({
      commandId: "cmd-resume-duplicates" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-duplicates" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 1,
      payload: {},
    });
    const command = {
      commandId: "cmd-turn-duplicates" as never,
      type: "turn.send" as const,
      runId: created.runId,
      correlationId: "corr-turn-duplicates" as never,
      actor: { kind: "user" as const, id: "test" },
      issuedAt: 2,
      payload: { prompt: "hello", turnId: "turn-duplicates" as never },
    };

    const receipts = await Promise.all(
      Array.from({ length: 100 }, () => engine.submitReceipt(command)),
    );

    expect(new Set(receipts.map((receipt) => JSON.stringify(receipt))).size).toBe(1);
    expect(
      getEventsAfter(db, created.runId, -1).filter(
        (event) => event.type === "turn.started",
      ),
    ).toHaveLength(1);
    expect(getEffectsForCommand(db, command.commandId)).toHaveLength(1);
  });

  test("creates the snapshot, event, outbox row, and receipt atomically", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });

    const snapshot = await engine.createRun({ projectId: "project-1" });

    expect(snapshot.status).toBe("ready");
    expect(getEventsAfter(db, snapshot.runId, -1).map((event) => event.type)).toEqual([
      "run.created",
    ]);
    expect(
      db.query("SELECT COUNT(*) AS count FROM command_receipts WHERE run_id = ?")
        .get(snapshot.runId),
    ).toEqual({ count: 1 });
    expect(
      db.query("SELECT COUNT(*) AS count FROM projection_outbox WHERE run_id = ?")
        .get(snapshot.runId),
    ).toEqual({ count: 1 });
  });

  test("returns the original receipt before re-deciding a duplicate command", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });
    const created = await engine.createRun({ projectId: "project-1" });
    const resume = {
      commandId: "cmd-resume-fixed" as never,
      type: "run.resume" as const,
      runId: created.runId,
      correlationId: "corr-resume-fixed" as never,
      actor: { kind: "system" as const, id: "test" },
      issuedAt: 10,
      payload: {},
    };
    await engine.submit(resume);
    const stop = {
      commandId: "cmd-stop-fixed" as never,
      type: "run.stop" as const,
      runId: created.runId,
      correlationId: "corr-stop-fixed" as never,
      actor: { kind: "user" as const, id: "test" },
      issuedAt: 20,
      payload: { reason: "user" },
    };

    const first = await engine.submit(stop);
    const duplicate = await engine.submit(stop);

    expect(duplicate).toEqual(first);
    expect(
      getEventsAfter(db, created.runId, -1)
        .filter((event) => event.type === "run.stopping" || event.type === "run.stopped"),
    ).toHaveLength(2);
  });

  test("drains every queued command for one run in FIFO order", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });
    const created = await engine.createRun({ projectId: "project-1" });

    const resume = engine.submit({
      commandId: "cmd-resume-queued" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-queued" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 10,
      payload: {},
    });
    const turn = engine.submit({
      commandId: "cmd-turn-queued" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-queued" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 20,
      payload: { prompt: "hello", turnId: "turn-queued" as never },
    });
    const stop = engine.submit({
      commandId: "cmd-stop-queued" as never,
      type: "run.stop",
      runId: created.runId,
      correlationId: "corr-stop-queued" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 30,
      payload: { reason: "user" },
    });

    await Promise.all([resume, turn, stop]);

    expect(
      getEventsAfter(db, created.runId, -1).map((event) => event.type),
    ).toEqual([
      "run.created",
      "run.started",
      "turn.started",
      "run.stopping",
      "run.stopped",
    ]);
  });

  test("stopping atomically fences queued provider work before stop cleanup", async () => {
    const db = openMemoryStore();
    let sends = 0;
    let stops = 0;
    const engine = new OrchestrationEngine(db, {
      maxConcurrentRuns: 1,
      reactors: {
        "provider.send_turn": {
          execute: async () => {
            sends++;
            return [];
          },
          recover: async () => {
            sends++;
            return [];
          },
        },
        "provider.stop_session": {
          execute: async (effect) => {
            stops++;
            return [{
              type: "provider.event",
              payload: {
                providerInstanceId: "provider-1" as never,
                normalizedEvent: {
                  eventId: `ev-${effect.effectId}-stopped` as never,
                  type: "provider.session.stopped",
                  payload: {
                    providerInstanceId: "provider-1" as never,
                    reason: "user",
                  },
                  correlationId: `corr-${effect.effectId}` as never,
                },
              },
            }];
          },
          recover: async () => [],
        },
      },
    });
    const created = await engine.createRun({ projectId: "project-stop-fence" });
    await engine.submit({
      commandId: "cmd-resume-stop-fence" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-stop-fence" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 1,
      payload: {},
    });
    await engine.submit({
      commandId: "cmd-turn-stop-fence" as never,
      type: "turn.send",
      runId: created.runId,
      correlationId: "corr-turn-stop-fence" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 2,
      payload: { prompt: "wait", turnId: "turn-stop-fence" as never },
    });
    await engine.submit({
      commandId: "cmd-stop-fence" as never,
      type: "run.stop",
      runId: created.runId,
      correlationId: "corr-stop-fence" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 3,
      payload: { reason: "user" },
    });

    expect(getEffectsForCommand(db, "cmd-turn-stop-fence" as never)[0]).toMatchObject({
      status: "failed",
      lastErrorKind: "terminal",
    });
    expect(await engine.drainEffects()).toBe(1);
    expect(sends).toBe(0);
    expect(stops).toBe(1);
  });

  test("randomized cross-run submission preserves each run's FIFO order", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 4 });
    const runs = [];
    for (let index = 0; index < 8; index++) {
      const created = await engine.createRun({ projectId: `project-${index}` });
      await engine.submit({
        commandId: `cmd-resume-random-${index}` as never,
        type: "run.resume",
        runId: created.runId,
        correlationId: `corr-resume-random-${index}` as never,
        actor: { kind: "system", id: "test" },
        issuedAt: index,
        payload: {},
      });
      runs.push(created.runId);
    }

    const shuffled = runs.flatMap((runId, runIndex) =>
      Array.from({ length: 12 }, (_, eventIndex) => ({
        runId,
        runIndex,
        eventIndex,
      })),
    );
    let randomState = 0x5eed;
    for (let index = shuffled.length - 1; index > 0; index--) {
      randomState = (randomState * 1664525 + 1013904223) >>> 0;
      const swapIndex = randomState % (index + 1);
      [shuffled[index], shuffled[swapIndex]] = [
        shuffled[swapIndex]!,
        shuffled[index]!,
      ];
    }

    const expected = new Map<string, string[]>();
    const submissions = shuffled.map(({ runId, runIndex, eventIndex }, order) => {
      const text = `${runIndex}:${eventIndex}`;
      const values = expected.get(runId) ?? [];
      values.push(text);
      expected.set(runId, values);
      return engine.submit({
        commandId: `cmd-random-${runIndex}-${eventIndex}` as never,
        type: "provider.event",
        runId,
        correlationId: `corr-random-${runIndex}-${eventIndex}` as never,
        actor: { kind: "provider", id: "test" },
        issuedAt: order,
        payload: {
          providerInstanceId: "provider-test" as never,
          normalizedEvent: {
            eventId: `ev-random-${runIndex}-${eventIndex}` as never,
            type: "usage.recorded",
            payload: {
              inputTokens: eventIndex,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              thinkingTokens: 0,
              modelId: text,
            },
            correlationId:
              `corr-event-random-${runIndex}-${eventIndex}` as never,
          },
        },
      });
    });
    await Promise.all(submissions);

    for (const runId of runs) {
      const events = getEventsAfter(db, runId, -1);
      expect(events.map((event) => event.sequence)).toEqual(
        events.map((_, index) => index + 1),
      );
      expect(
        events
          .filter((event) => event.type === "usage.recorded")
          .map((event) => (event.payload as { modelId: string }).modelId),
      ).toEqual(expected.get(runId)!);
    }
  });

  test("rejects a command ID reused for a different run", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 2 });
    const first = await engine.createRun({ projectId: "project-1" });
    const second = await engine.createRun({ projectId: "project-2" });
    const command = {
      commandId: "cmd-cross-run" as never,
      type: "run.resume" as const,
      correlationId: "corr-cross-run" as never,
      actor: { kind: "system" as const, id: "test" },
      issuedAt: 10,
      payload: {},
    };

    await engine.submit({ ...command, runId: first.runId });

    await expect(
      engine.submit({ ...command, runId: second.runId }),
    ).rejects.toThrow("different run");
  });

  test("continues draining a run queue after one command is rejected", async () => {
    const db = openMemoryStore();
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });
    const created = await engine.createRun({ projectId: "project-1" });

    const invalidStop = engine.submit({
      commandId: "cmd-invalid-stop" as never,
      type: "run.stop",
      runId: created.runId,
      correlationId: "corr-invalid-stop" as never,
      actor: { kind: "user", id: "test" },
      issuedAt: 10,
      payload: { reason: "user" },
    });
    const validResume = engine.submit({
      commandId: "cmd-resume-after-error" as never,
      type: "run.resume",
      runId: created.runId,
      correlationId: "corr-resume-after-error" as never,
      actor: { kind: "system", id: "test" },
      issuedAt: 20,
      payload: {},
    });

    const results = await Promise.allSettled([invalidStop, validResume]);

    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("fulfilled");
    expect(
      getEventsAfter(db, created.runId, -1).map((event) => event.type),
    ).toEqual(["run.created", "run.started"]);
  });

  test("rolls back initial snapshot when run creation persistence fails", async () => {
    const db = openMemoryStore();
    db.run(`
      CREATE TRIGGER reject_run_event
      BEFORE INSERT ON run_events
      BEGIN
        SELECT RAISE(FAIL, 'injected event failure');
      END
    `);
    const engine = new OrchestrationEngine(db, { maxConcurrentRuns: 1 });

    await expect(engine.createRun({ projectId: "project-1" })).rejects.toThrow(
      "injected event failure",
    );

    expect(db.query("SELECT COUNT(*) AS count FROM run_snapshots").get()).toEqual({
      count: 0,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual({
      count: 0,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM projection_outbox").get()).toEqual({
      count: 0,
    });
  });
});
