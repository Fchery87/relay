import type {
  CheckpointId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  TurnId,
} from "./ids";
import type { CanonicalEvent } from "./events";
import type { PermissionProfile } from "./permissions";
import type { WorkspaceRecord } from "./workspace";

// ---------------------------------------------------------------------------
// Run status — the state machine's states.
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
  "created",
  "ready",
  "running",
  "awaiting_approval",
  "stopping",
  "stopped",
  "completed",
  "failed",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

// ---------------------------------------------------------------------------
// Run snapshot — the immutable state of a run at a point in time.
// ---------------------------------------------------------------------------

export type RunSnapshot = {
  readonly runId: RunId;
  readonly projectId?: ProjectId;
  readonly status: RunStatus;
  readonly sequence: number;
  readonly streamVersion: number;
  /** The turn currently active, if any. */
  readonly activeTurnId?: TurnId;
  /** The provider currently serving this run, if one has been selected. */
  readonly providerInstanceId?: ProviderInstanceId;
  readonly permissionProfile?: PermissionProfile;
  readonly workspace?: WorkspaceRecord;
  readonly providerSession?: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerThreadId?: string;
  };
  readonly checkpoint?: {
    readonly checkpointId: CheckpointId;
    readonly turnId: TurnId;
    readonly commit: string;
    readonly ref: string;
    readonly capturedAt: number;
  };
  /** Provider-independent reducer state not promoted to a first-class field. */
  readonly reducerPayload?: Readonly<Record<string, JsonValue>>;
  /** The number of times this run has been restarted. */
  readonly restartCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Allowed transitions — which status changes are valid.
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  created: new Set(["ready", "failed"]),
  ready: new Set(["running", "failed"]),
  running: new Set(["awaiting_approval", "stopping", "completed", "failed"]),
  awaiting_approval: new Set(["running", "stopping", "failed"]),
  stopping: new Set(["stopped", "failed"]),
  stopped: new Set(),
  completed: new Set(),
  failed: new Set(),
};

// ---------------------------------------------------------------------------
// Pure reducer — the ONLY function that defines run-status semantics.
// Performs no I/O; exhaustive switch checks enforced by TypeScript.
// ---------------------------------------------------------------------------

/**
 * Derive the next run status and metadata from a canonical event.
 * Returns the partial snapshot updates to apply, or `null` if the
 * event does not change run status.
 */
export function reduceRun(
  snapshot: RunSnapshot,
  event: CanonicalEvent,
): Partial<RunSnapshot> | null {
  const current = snapshot.status;
  const now = event.occurredAt;

  switch (event.type) {
    // --- run lifecycle ---
    case "run.created": {
      if (current === "ready") return null;
      assertTransition(current, "ready");
      return {
        status: "ready",
        projectId: event.payload.projectId,
        updatedAt: now,
        ...(event.payload.providerInstanceId === undefined
          ? {}
          : { providerInstanceId: event.payload.providerInstanceId }),
      };
    }

    case "run.started": {
      // ready → running (or already running, idempotent).
      if (current === "running") return null;
      assertTransition(current, "running");
      return { status: "running", updatedAt: now };
    }

    case "run.stopping": {
      if (current === "stopping") return null;
      assertTransition(current, "stopping");
      return { status: "stopping", updatedAt: now };
    }

    case "run.stopped": {
      if (current === "stopped") return null;
      assertTransition(current, "stopped");
      return { status: "stopped", activeTurnId: undefined, updatedAt: now };
    }

    case "run.failed": {
      if (current === "failed") return null;
      assertTransition(current, "failed");
      return { status: "failed", activeTurnId: undefined, updatedAt: now };
    }

    // --- turn events may gate status transitions ---
    // These do NOT directly change run status — the orchestration engine
    // processes them and may emit follow-up internal commands.
    case "turn.started":
      if (!event.turnId) {
        throw new Error("turn.started requires a turnId");
      }
      return { activeTurnId: event.turnId, updatedAt: now };

    case "turn.steered":
      return null;

    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted": {
      if (event.turnId && event.turnId !== snapshot.activeTurnId) return null;
      return { activeTurnId: undefined, updatedAt: now };
    }

    // --- provider session events ---
    case "provider.session.started":
    case "provider.session.resumed":
      return {
        providerInstanceId: event.payload.providerInstanceId,
        providerSession: {
          providerInstanceId: event.payload.providerInstanceId,
          ...(event.payload.providerThreadId === undefined
            ? {}
            : { providerThreadId: event.payload.providerThreadId }),
        },
        updatedAt: now,
      };

    case "provider.session.stopped":
      return null;

    // --- assistant events ---
    case "assistant.delta":
    case "assistant.completed":
      return null;

    // --- activity events ---
    case "activity.started":
    case "activity.delta":
    case "activity.completed":
    case "activity.failed":
      return null;

    // --- approval events ---
    case "approval.requested": {
      if (current === "awaiting_approval") return null;
      assertTransition(current, "awaiting_approval");
      return { status: "awaiting_approval", updatedAt: now };
    }

    case "approval.resolved": {
      // Approval resolution transitions back to running.
      if (current === "running") return null;
      assertTransition(current, "running");
      return { status: "running", updatedAt: now };
    }

    // --- usage, checkpoint, projection events ---
    case "usage.recorded":
      return null;

    case "checkpoint.captured":
      if (!event.turnId) {
        throw new Error("checkpoint.captured requires a turnId");
      }
      return {
        checkpoint: {
          checkpointId: event.payload.checkpointId,
          turnId: event.turnId,
          commit: event.payload.commit,
          ref: event.payload.ref,
          capturedAt: now,
        },
        updatedAt: now,
      };

    case "checkpoint.restored":
    case "projection.published":
      return null;

    default: {
      // Exhaustiveness check — compile-time guarantee.
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertTransition(
  current: RunStatus,
  target: RunStatus,
): void {
  const allowed = ALLOWED_TRANSITIONS[current];
  if (!allowed.has(target)) {
    throw new RunTransitionError(current, target);
  }
}

export class RunTransitionError extends Error {
  constructor(
    public readonly from: RunStatus,
    public readonly to: RunStatus,
  ) {
    super(`Invalid run state transition: ${from} → ${to}`);
    this.name = "RunTransitionError";
  }
}

// ---------------------------------------------------------------------------
// Snapshot application — apply a partial update to create a new snapshot.
// ---------------------------------------------------------------------------

export function applySnapshot(
  snapshot: RunSnapshot,
  update: Partial<RunSnapshot> | null,
): RunSnapshot {
  if (!update) return snapshot;
  return {
    ...snapshot,
    ...update,
    sequence: update.sequence ?? snapshot.sequence,
    streamVersion: update.streamVersion ?? snapshot.streamVersion,
    updatedAt: update.updatedAt ?? snapshot.updatedAt,
  };
}
