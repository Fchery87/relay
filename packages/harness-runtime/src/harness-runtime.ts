import type { RunSnapshot } from "@relay/contracts";
import type { RunId, CommandId, TurnId } from "@relay/contracts";
import type {
  CanonicalEventDraft,
  CanonicalEventType,
  EventEnvelope,
} from "@relay/contracts";

// ---------------------------------------------------------------------------
// Input types — deliberately narrow; no store, provider, or Convex detail.
// ---------------------------------------------------------------------------

export type CreateRunInput = {
  readonly projectId: string;
  readonly permissionProfile?: "read-only" | "workspace-write" | "full-access";
  /**
   * The canonical run ID assigned at the command-ingress boundary (browser
   * command / commandInbox — defaults to the thread ID when omitted). When
   * provided, the local run is created under this exact ID instead of a
   * randomly generated one, so `run.resume`/`turn.send` commands that
   * reference the same canonical ID can find it. Omit only for callers
   * (tests, internal tooling) that have no external identity to preserve.
   */
  readonly runId?: RunId;
};

export type ResumeRunInput = {
  readonly runId: RunId;
};

export type SendTurnInput = {
  readonly runId: RunId;
  readonly prompt: string;
  /** Stable identities may be supplied when retrying delivery. */
  readonly commandId?: CommandId;
  readonly turnId?: TurnId;
};

export type SteerTurnInput = {
  readonly runId: RunId;
  readonly steering: string;
};

export type InterruptTurnInput = {
  readonly runId: RunId;
  readonly reason?: string;
};

export type ResolveApprovalInput = {
  readonly runId: RunId;
  readonly approvalId: string;
  readonly resolution: "allow" | "deny";
};

export type StopRunInput = {
  readonly runId: RunId;
  readonly reason?: string;
};

export type SnapshotInput = {
  readonly runId: RunId;
};

export type ObserveInput = {
  readonly runId: RunId;
  /** Resume observation from this sequence (exclusive). */
  readonly afterSequence?: number;
  /** Stop a live observation without waiting for another event. */
  readonly signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type TurnReceipt = {
  readonly turnId: TurnId;
  readonly commandId: CommandId;
};

export type AppendEventInput =
  CanonicalEventDraft extends infer TDraft
    ? TDraft extends CanonicalEventDraft
      ? Omit<TDraft, "eventId" | "correlationId" | "causationId"> & {
          readonly eventId: string;
          readonly correlationId?: string;
        }
      : never
    : never;

export type AppendEventResult =
  | { ok: true; sequence: number }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// The deep HarnessRuntime interface — the single primary seam.
// Workspace, provider, store, and Convex adapters are deliberately kept out.
// The same conformance suite runs against the fake, the local implementation,
// and the Codex adapter.
// ---------------------------------------------------------------------------

export interface HarnessRuntime {
  /** Create a new run. Returns the initial snapshot. */
  createRun(input: CreateRunInput): Promise<RunSnapshot>;

  /** Resume a previously-created or interrupted run. */
  resumeRun(input: ResumeRunInput): Promise<RunSnapshot>;

  /** Send a user turn (prompt) to a running or ready run. */
  sendTurn(input: SendTurnInput): Promise<TurnReceipt>;

  /** Inject a steering message into an active turn. */
  steerTurn(input: SteerTurnInput): Promise<void>;

  /** Interrupt (abort) the active turn. */
  interruptTurn(input: InterruptTurnInput): Promise<void>;

  /** Resolve a pending approval request. */
  resolveApproval(input: ResolveApprovalInput): Promise<void>;

  /** Request the run to stop (graceful shutdown). */
  stopRun(input: StopRunInput): Promise<void>;

  /** Return a point-in-time snapshot of the run. */
  snapshot(input: SnapshotInput): Promise<RunSnapshot>;

  /** Observe the ordered canonical event stream for a run.
   *  If afterSequence is provided, only events with sequence > afterSequence
   *  are yielded. The stream stays open until the run reaches a terminal status
   *  or the consumer breaks the iteration. */
  observe(input: ObserveInput): AsyncIterable<EventEnvelope<CanonicalEventType, unknown>>;

  /** Append raw events for a run (used by provider adapters to stream
   *  turn deltas, usage records, and completion/failure events). */
  appendEvent(runId: RunId, input: AppendEventInput): Promise<AppendEventResult>;

  /** List all active run IDs known to the runtime. */
  listRuns(): ReadonlyArray<{ runId: string; status: string }>;
}
