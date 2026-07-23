import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CanonicalEventType, EventEnvelope, RunSnapshot } from "@relay/contracts";
import { LocalHarnessRuntime } from "@relay/harness-runtime";
import { createDeterministicProviderReactor, ShadowEffectFence, ShadowEvidenceStore, ShadowSupervisor, type ShadowEffect, type ShadowEvidence } from "@relay/orchestration";
import type { ConversationGateway } from "../agent-loop";
import { ProjectionComparator, type ProjectionComparison, type ShadowProjection } from "./projection-comparator";

type LegacyTurn = {
  readonly runId: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly permissionProfile?: "read-only" | "workspace-write" | "full-access";
  readonly effects: ShadowEffect[];
  readonly events: Array<EventEnvelope<CanonicalEventType, unknown>>;
  assistantText: string;
  messageId?: string;
};

export type ShadowRuntimeOptions = {
  readonly evidencePath: string;
  readonly tickIntervalMs?: number;
  /** Test and protected environments may force a deterministic kernel result. */
  readonly kernelText?: string;
};

/**
 * Shadow-mode application runtime.
 *
 * Legacy still calls the real gateway and therefore owns all remote, provider,
 * workspace, checkpoint, and projection effects. Shadow only receives the
 * normalized record after the legacy call has been made, runs a deterministic
 * local replay, compares projections, and persists the result.
 */
export class ShadowRuntime {
  readonly #supervisor = new ShadowSupervisor();
  readonly #effectFence = new ShadowEffectFence();
  readonly #evidence = new ShadowEvidenceStore();
  readonly #comparator = new ProjectionComparator();
  readonly #turns = new Map<string, LegacyTurn>();
  readonly #options: ShadowRuntimeOptions;
  #loaded = false;

  constructor(options: ShadowRuntimeOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (!this.#loaded) {
      await this.loadEvidence();
      this.#loaded = true;
    }
    this.#supervisor.start(() => undefined, this.#options.tickIntervalMs ?? 30_000);
  }

  stop(): void {
    this.#supervisor.stop();
  }

  get active(): boolean {
    return this.#supervisor.active;
  }

  get effects(): ReadonlyArray<ShadowEffect> {
    return this.#effectFence.effects;
  }

  get evidence(): ReadonlyArray<ShadowEvidence> {
    return this.#evidence.records;
  }

  promotionBlocked(): boolean {
    return this.#evidence.promotionBlocked();
  }

  /** Record the point where legacy has claimed a user turn. */
  beginLegacyTurn(input: { permissionProfile?: "read-only" | "workspace-write" | "full-access"; projectId?: string; prompt: string; runId: string }): void {
    if (this.#turns.has(input.runId)) return;
    const turn = {
      runId: input.runId,
      projectId: input.projectId ?? "legacy-project",
      prompt: input.prompt,
      permissionProfile: input.permissionProfile,
      effects: [],
      events: [],
      assistantText: "",
    } satisfies LegacyTurn;
    this.appendLegacyEvent(turn, "run.created", { environmentId: "local", projectId: turn.projectId, ...(turn.permissionProfile ? { permissionProfile: turn.permissionProfile } : {}) });
    this.appendLegacyEvent(turn, "run.started", {});
    this.appendLegacyEvent(turn, "turn.started", { prompt: turn.prompt }, `turn-${turn.runId}`);
    this.#turns.set(input.runId, turn);
  }

  /** Record a legacy-owned effect intent; this never executes an effect. */
  recordLegacyEffect(input: { effectId: string; kind: string; runId: string }): void {
    const effect: ShadowEffect = { effectId: input.effectId, kind: input.kind, owner: "legacy" };
    this.#effectFence.record(effect);
    this.#turns.get(input.runId)?.effects.push(effect);
  }

  recordLegacyAssistantText(input: { messageId: string; text: string; runId: string }): void {
    const turn = this.#turns.get(input.runId);
    if (!turn) return;
    turn.messageId = input.messageId;
    turn.assistantText += input.text;
    this.appendLegacyEvent(turn, "assistant.delta", { text: input.text }, `turn-${turn.runId}`);
  }

  /** Complete and compare one captured legacy turn. */
  async finishLegacyTurn(input: { messageId: string; runId: string; status?: "done" | "failed" }): Promise<ProjectionComparison | null> {
    const turn = this.#turns.get(input.runId);
    if (!turn || (turn.messageId && turn.messageId !== input.messageId)) return null;
    this.recordLegacyEffect({ effectId: `turn:${turn.runId}`, kind: "turn.complete", runId: turn.runId });
    if (input.status !== "failed") this.appendLegacyEvent(turn, "assistant.completed", {}, `turn-${turn.runId}`);
    const eventType = input.status === "failed" ? "turn.failed" : "turn.completed";
    this.appendLegacyEvent(turn, eventType, input.status === "failed" ? { error: "legacy turn failed" } : { summary: turn.assistantText }, `turn-${turn.runId}`);
    const legacy: ShadowProjection = {
      events: turn.events,
      snapshot: legacySnapshot(turn),
    };
    const kernel = await this.runDeterministicKernel(turn);
    const comparison = this.#comparator.compare({ kernel, legacy, allowFormatting: false });
    const evidence: ShadowEvidence = {
      correlationId: `shadow:${turn.runId}`,
      runId: turn.runId,
      timestamp: Date.now(),
      parityReport: comparison.report,
      kernelSnapshot: kernel.snapshot,
      legacySnapshot: legacy.snapshot,
      allowlistRefs: comparison.allowlistRefs,
    };
    this.#evidence.record(evidence);
    await this.persistEvidence(evidence);
    this.#turns.delete(input.runId);
    return comparison;
  }

  /** Wrap the real legacy conversation gateway at its effect boundary. */
  wrapConversationGateway(gateway: ConversationGateway): ConversationGateway {
    return new Proxy(gateway, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          if (property === "claimQueuedMessage") {
            return Promise.resolve(result).then((queued) => {
              if (queued && typeof queued === "object" && "threadId" in queued && "content" in queued) {
                const item = queued as { content: string; permissionProfile?: "read-only" | "workspace-write" | "full-access"; projectId?: string; threadId: string };
                this.beginLegacyTurn({ permissionProfile: item.permissionProfile, projectId: item.projectId, prompt: item.content, runId: item.threadId });
              }
              return queued;
            });
          }
          if (property === "beginAssistantMessage") {
            return Promise.resolve(result).then((messageId) => {
              const runId = args[0] && typeof args[0] === "object" && "threadId" in args[0] ? String((args[0] as { threadId: string }).threadId) : undefined;
              if (runId && typeof messageId === "string") {
                const turn = this.#turns.get(runId);
                if (turn) turn.messageId = messageId;
                this.recordLegacyEffect({ effectId: `message:${messageId}`, kind: "assistant.message", runId });
              }
              return messageId;
            });
          }
          if (property === "appendAssistantText") {
            const runId = this.runIdForMessage(args[0]);
            if (runId && args[0] && typeof args[0] === "object") {
              const item = args[0] as { content?: string; messageId?: string };
              this.recordLegacyAssistantText({ messageId: item.messageId ?? "unknown", text: item.content ?? "", runId });
            }
          }
          if (property === "completeAssistantMessage") {
            const item = args[0] as { messageId?: string; status?: "done" | "failed"; threadId?: string };
            if (item?.threadId && item.messageId) {
              return Promise.resolve(result).then(async (value) => {
                try {
                  await this.finishLegacyTurn({ messageId: item.messageId!, runId: item.threadId!, status: item.status });
                } catch (error) {
                  // Shadow evidence must never steal legacy effect ownership.
                  console.error("Relay shadow comparison failed", error);
                }
                return value;
              });
            }
          }
          return result;
        };
      },
    }) as ConversationGateway;
  }

  private runIdForMessage(input: unknown): string | undefined {
    if (!input || typeof input !== "object") return undefined;
    const messageId = (input as { messageId?: string }).messageId;
    if (!messageId) return undefined;
    for (const turn of this.#turns.values()) if (turn.messageId === messageId) return turn.runId;
    return undefined;
  }

  private appendLegacyEvent(turn: LegacyTurn, type: CanonicalEventType, payload: unknown, turnId?: string): void {
    const sequence = turn.events.length + 1;
    turn.events.push({
      eventId: `legacy-${turn.runId}-${sequence}` as never,
      sequence,
      streamVersion: sequence,
      type,
      runId: turn.runId as never,
      turnId: turnId as never,
      correlationId: `legacy:${turn.runId}` as never,
      occurredAt: Date.now(),
      payload,
    } as EventEnvelope<CanonicalEventType, unknown>);
  }

  private async runDeterministicKernel(turn: LegacyTurn): Promise<ShadowProjection> {
    const runtime = LocalHarnessRuntime.memory({
      reactors: {
        "provider.send_turn": createDeterministicProviderReactor({ text: this.#options.kernelText ?? turn.assistantText }),
      },
    });
    try {
      await runtime.createRun({ runId: turn.runId as never, projectId: turn.projectId as never });
      await runtime.resumeRun({ runId: turn.runId as never });
      await runtime.sendTurn({ runId: turn.runId as never, prompt: turn.prompt, commandId: `shadow:${turn.runId}` as never, turnId: `turn-${turn.runId}` as never });
      await runtime.drainEffects();
      const events: Array<EventEnvelope<CanonicalEventType, unknown>> = [];
      const controller = new AbortController();
      for await (const event of runtime.observe({ runId: turn.runId as never, signal: controller.signal })) {
        events.push(event);
        // A deterministic provider turn has the six canonical lifecycle
        // events below. Abort observation after the complete prefix so a
        // non-terminal shadow run does not leave the legacy poller waiting.
        if (events.length >= 6) {
          controller.abort();
          break;
        }
      }
      return { events, snapshot: await runtime.snapshot({ runId: turn.runId as never }) };
    } finally {
      await runtime.shutdown();
    }
  }

  private async loadEvidence(): Promise<void> {
    try {
      const content = await readFile(this.#options.evidencePath, "utf8");
      const records: ShadowEvidence[] = [];
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line) as ShadowEvidence); } catch { /* retain the valid records */ }
      }
      this.#evidence.hydrate(records);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persistEvidence(evidence: ShadowEvidence): Promise<void> {
    await mkdir(dirname(this.#options.evidencePath), { recursive: true });
    await appendFile(this.#options.evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
  }
}

function legacySnapshot(turn: LegacyTurn): RunSnapshot {
  return {
    runId: turn.runId as never,
    projectId: turn.projectId as never,
    permissionProfile: turn.permissionProfile ?? "workspace-write",
    status: "running",
    sequence: turn.events.length,
    streamVersion: turn.events.length,
    restartCount: 0,
    createdAt: turn.events[0]?.occurredAt ?? Date.now(),
    updatedAt: turn.events.at(-1)?.occurredAt ?? Date.now(),
  };
}
