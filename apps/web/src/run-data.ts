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

export const listProjectionRuns = makeFunctionReference<"query", { projectId: string }, ProjectionRunSummary[]>("projections:listProjectionRuns");

export const getProjectionSnapshot = makeFunctionReference<"query", { runId: string }, Record<string, unknown> | null>("projections:getRunSnapshot");

export const listProjectionEvents = makeFunctionReference<"query", { runId: string; afterSequence: number; limit: number }, Array<{ eventId: string; type: string; payload: unknown; sequence: number }>>("projections:listRunEvents");

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

/**
 * The web app deliberately consumes the authenticated legacy transport through this
 * boundary until owner-scoped, contiguous kernel projections are production-verified.
 * Pass `RELAY_VITE_PROJECTION_ENABLED=true` to switch to projection reads.
 */
export const legacyRunData: RunDataBoundary = {
  source: "legacy",
  listRuns: listLegacyRuns,
};
