import type { PlanPhase } from "./plan-panel";
import type { ThreadStatus } from "./thread-messages";

export type HandoffStage = "request" | "plan" | "tools" | "review" | "deliver";

const HANDOFF_STAGES: ReadonlyArray<{ id: HandoffStage; label: string }> = [
  { id: "request", label: "Request" },
  { id: "plan", label: "Plan" },
  { id: "tools", label: "Tools" },
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
  if (status === "queued" || status === "running" || status === "restoring" || planPhase === "building") return "tools";
  if (mode === "plan" && planPhase === "planning") return "plan";
  return "request";
}

export function HandoffTrace({ currentStage }: { currentStage: HandoffStage }) {
  const currentIndex = HANDOFF_STAGES.findIndex((stage) => stage.id === currentStage);

  return (
    <ol aria-label="Run handoff" className="handoff-trace">
      {HANDOFF_STAGES.map((stage, index) => {
        const state = index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming";
        return (
          <li aria-current={state === "current" ? "step" : undefined} data-state={state} key={stage.id}>
            <span aria-hidden="true" className="handoff-contact" />
            <span>{stage.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
