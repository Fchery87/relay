import { makeFunctionReference } from "convex/server";
import type { PlanPhase } from "./plan-panel";
import type { ThreadStatus } from "./thread-messages";
import type { ThinkingLevel } from "@relay/shared";

export type MachineSummary = {
  capabilityCeiling?: ReadonlyArray<"read" | "edit" | "exec" | "task">;
  id: string;
  lastHeartbeatAt: number;
  name: string;
  platform: "darwin" | "linux" | "win32";
  projects: ReadonlyArray<{ archivedAt?: number; error?: string; id: string; name: string; path: string; status?: string }>;
};

export type PermissionProfile = "read-only" | "workspace-write" | "full-access";

export type LegacyRunSummary = {
  _id: string;
  buildModelId?: string;
  mode?: "chat" | "plan";
  modelId?: string;
  permissionProfile?: PermissionProfile;
  planModelId?: string;
  planPhase?: PlanPhase;
  status: ThreadStatus;
  stopRequested?: boolean;
  thinkingLevel?: ThinkingLevel;
  title: string;
};

export type NeedsYouItem = {
  kind: "approval" | "plan-review" | "elicitation" | "failed";
  projectId: string;
  projectName: string;
  threadId: string;
  title: string;
};

export const listNeedsYou = makeFunctionReference<"query", Record<string, never>, NeedsYouItem[]>("attention:listNeedsYou");

export const createThreadRef = makeFunctionReference<
  "mutation",
  { mode?: "chat" | "plan"; permissionProfile?: PermissionProfile; projectId: string; title: string },
  string
>("conversations:createThread");

export const updatePermissionProfileRef = makeFunctionReference<
  "mutation",
  { permissionProfile: PermissionProfile; threadId: string },
  null
>("conversations:updatePermissionProfile");

export const removeThreadRef = makeFunctionReference<
  "mutation",
  { threadId: string },
  null
>("conversations:removeThread");

export const requestAddProjectRef = makeFunctionReference<
  "mutation",
  { machineId: string; name: string; path: string },
  string
>("projects:requestAdd");

export type ProjectionRunSummary = {
  runId: string;
  sequence: number;
  status: string;
  title: string;
  projectId: string;
  updatedAt: number;
};

export type RunDataSource = "legacy" | "projection";

export type RunDataBoundary = {
  source: RunDataSource;
  listRuns: typeof listLegacyRuns | typeof listProjectionRuns;
  /** Optional: read a single projection snapshot by runId. */
  getRunSnapshot?: typeof getProjectionSnapshot;
  /** Optional: read projection events after a given sequence. */
  listRunEvents?: typeof listProjectionEvents;
};

export const listLegacyRuns = makeFunctionReference<"query", { projectId: string }, LegacyRunSummary[]>("conversations:listProjectThreads");

export const listProjectionRuns = makeFunctionReference<"query", { projectId: string }, ProjectionRunSummary[]>("projections/publish:listProjectionRuns");

export const getProjectionSnapshot = makeFunctionReference<"query", { runId: string }, Record<string, unknown> | null>("projections/publish:getRunSnapshot");

export const listProjectionEvents = makeFunctionReference<"query", { runId: string; afterSequence: number; limit: number }, Array<{ eventId: string; type: string; payload: unknown; sequence: number }>>("projections/publish:listRunEvents");

/** Resolve the run-data boundary at app startup. */
export function resolveRunData(projectionEnabled: boolean): RunDataBoundary {
  if (projectionEnabled) {
    return {
      source: "projection",
      listRuns: listProjectionRuns,
      getRunSnapshot: getProjectionSnapshot,
      listRunEvents: listProjectionEvents,
    };
  }
  return { source: "legacy", listRuns: listLegacyRuns };
}

/** The browser reads legacy thread rows while the daemon's default runtime is
 * legacy — projections are only published by the kernel-mode daemon, so
 * projection reads return nothing until cutover. Switch back to
 * `projectionRunData` when kernel becomes the effective default. */
export const canonicalRunData: RunDataBoundary = { source: "legacy", listRuns: listLegacyRuns };
/** Projection boundary; becomes canonical at kernel cutover. */
export const projectionRunData: RunDataBoundary = {
  source: "projection",
  listRuns: listProjectionRuns,
  getRunSnapshot: getProjectionSnapshot,
  listRunEvents: listProjectionEvents,
};
/** @deprecated alias retained for rollback tooling; same boundary as canonicalRunData. */
export const legacyRunData: RunDataBoundary = canonicalRunData;

/** Adapt legacy thread rows to the run-summary shape the sidebar and palette render. */
export function toRunSummaries(threads: LegacyRunSummary[] | undefined): ProjectionRunSummary[] | undefined {
  return threads?.map((thread) => ({ projectId: "", runId: thread._id, sequence: 0, status: thread.status, title: thread.title, updatedAt: 0 }));
}

// ---------------------------------------------------------------------------
// Canonical command submission — browser actions submit stable command IDs
// through the canonical inbox instead of legacy per-type mutations.
// ---------------------------------------------------------------------------

export const submitCanonicalCommand = makeFunctionReference<
  "mutation",
  {
    commandId: string;
    correlationId: string;
    kind: string;
    payloadJson: string;
    runId?: string;
    threadId: string;
  },
  string
>("commands/inbox:submitToInbox");

/** Generate a stable command ID from run and turn context. */
export function canonicalCommandId(runId: string, kind: string, sequence?: number): string {
  const seq = sequence ?? Date.now();
  return `cmd-${kind.replace(".", "-")}-${runId.slice(-8)}-${seq}`;
}

// ---------------------------------------------------------------------------
// Projection cursor — tracks the confirmed event sequence per run for
// ordered reconnect without gaps or duplicates.
// ---------------------------------------------------------------------------

export type ProjectionCursor = {
  runId: string;
  confirmedSequence: number;
  updatedAt: number;
};

/**
 * Reconnect cursor manager — persists confirmed sequence in sessionStorage
 * so a reconnecting browser can resume without gaps.
 */
export class ProjectionCursorManager {
  #prefix: string;

  constructor(storageKey: string = "relay-projection-cursors") {
    this.#prefix = storageKey;
  }

  #key(runId: string): string {
    return `${this.#prefix}:${runId}`;
  }

  load(runId: string): ProjectionCursor | null {
    try {
      const raw = localStorage.getItem(this.#key(runId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ProjectionCursor;
      if (parsed.runId !== runId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  save(runId: string, confirmedSequence: number): void {
    const cursor: ProjectionCursor = {
      runId,
      confirmedSequence,
      updatedAt: Date.now(),
    };
    localStorage.setItem(this.#key(runId), JSON.stringify(cursor));
  }

  /**
   * Validate that reconnection is safe: no gap between the last confirmed
   * sequence and the next event to fetch.
   */
  validateReconnect(runId: string, nextSequence: number): { ok: true } | { ok: false; gap: number; lastConfirmed: number } {
    const cursor = this.load(runId);
    if (!cursor) return { ok: true }; // No cursor yet — first connection.
    if (nextSequence <= cursor.confirmedSequence + 1) return { ok: true };
    return { ok: false, gap: nextSequence - cursor.confirmedSequence - 1, lastConfirmed: cursor.confirmedSequence };
  }

  clear(runId: string): void {
    localStorage.removeItem(this.#key(runId));
  }
}
