import { HANDOFF_STAGES, type HandoffStage } from "./handoff-trace-utils";

export type { HandoffStage } from "./handoff-trace-utils";

export function HandoffTrace({ currentStage }: { currentStage: HandoffStage }) {
  const currentIndex = HANDOFF_STAGES.findIndex((stage) => stage.id === currentStage);

  return (
    <ol aria-label="Run workflow" className="handoff-trace">
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
