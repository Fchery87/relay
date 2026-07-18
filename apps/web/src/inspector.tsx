import { HandoffTrace, type HandoffStage } from "./handoff-trace";
import { UsagePanel, type UsageSummary } from "./usage-panel";
import type { SubagentRun } from "./subagent-panel";

export function InspectorPanel({
  capabilityCeiling,
  currentStage,
  machineName,
  onBudgetChange,
  onShowApprovals,
  pendingApprovalCount,
  permissionProfile,
  projectName,
  subagentRuns,
  usage,
}: {
  capabilityCeiling: ReadonlyArray<"read" | "edit" | "exec" | "task">;
  currentStage: HandoffStage;
  machineName: string;
  onBudgetChange?: (budgetUsd: number | null) => Promise<unknown>;
  onShowApprovals?: () => void;
  pendingApprovalCount: number;
  permissionProfile: string;
  projectName: string;
  subagentRuns: ReadonlyArray<SubagentRun>;
  usage: UsageSummary;
}) {
  return (
    <div className="inspector-content">
      <div className="inspector-section">
        <h3>Stage</h3>
        <HandoffTrace currentStage={currentStage} />
      </div>
      <div className="inspector-section">
        <h3>Environment</h3>
        <dl className="inspector-facts">
          <div><dt>Machine</dt><dd><span className="presence presence-online" aria-hidden="true" />{machineName}</dd></div>
          <div><dt>Repository</dt><dd>{projectName}</dd></div>
          <div><dt>Branch</dt><dd>Detached worktree</dd></div>
          <div><dt>Access</dt><dd>{permissionProfile}</dd></div>
          <div><dt>Ceiling</dt><dd>{capabilityCeiling.length > 0 ? capabilityCeiling.join(" · ") : "Policy default"}</dd></div>
        </dl>
      </div>
      {pendingApprovalCount > 0 ? (
        <div className="inspector-section inspector-needs-you">
          <h3>Needs you</h3>
          <button className="inspector-action" onClick={() => onShowApprovals?.()} type="button">
            <span aria-hidden="true" className="needs-you-contact">◆</span>
            <strong>{pendingApprovalCount} pending {pendingApprovalCount === 1 ? "approval" : "approvals"}</strong>
          </button>
        </div>
      ) : null}
      <div className="inspector-section">
        <h3>Agents</h3>
        {subagentRuns.length === 0 ? (
          <p className="inspector-empty">No delegated runs.</p>
        ) : (
          <ul className="inspector-agents">
            {subagentRuns.map((run) => (
              <li key={run._id}><span>{run.task}</span><small>{run.status}</small></li>
            ))}
          </ul>
        )}
      </div>
      <div className="inspector-section">
        <h3>Usage</h3>
        <UsagePanel onBudgetChange={onBudgetChange} value={usage} />
      </div>
    </div>
  );
}
