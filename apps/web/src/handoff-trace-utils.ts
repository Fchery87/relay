import type { PlanPhase } from "./plan-panel";
import type { ThreadStatus } from "./thread-messages";

export type HandoffStage = "request" | "plan" | "execute" | "review" | "deliver";

export const HANDOFF_STAGES: ReadonlyArray<{ id: HandoffStage; label: string }> = [
  { id: "request", label: "Request" },
  { id: "plan", label: "Plan" },
  { id: "execute", label: "Execute" },
  { id: "review", label: "Review" },
  { id: "deliver", label: "Deliver" },
];

export function resolveHandoffStage({
  hasPendingApproval,
  mode,
  planPhase,
  status,
}: {
  hasPendingApproval: boolean;
  mode: "chat" | "plan";
  planPhase?: PlanPhase;
  status: ThreadStatus;
}): HandoffStage {
  if (status === "done" || planPhase === "complete") return "deliver";
  if (status === "awaiting-approval" || hasPendingApproval || planPhase === "review") return "review";
  if (status === "queued" || status === "running" || status === "restoring" || planPhase === "building") return "execute";
  if (mode === "plan" && planPhase === "planning") return "plan";
  return "request";
}
