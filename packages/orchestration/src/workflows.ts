import type { RunSnapshot } from "@relay/contracts";

export type WorkflowStep = Readonly<{ name: string; execute: (runId: string) => Promise<RunSnapshot> }>;
export type WorkflowDefinition = Readonly<{ name: string; steps: readonly WorkflowStep[] }>;
export async function executeWorkflow(workflow: WorkflowDefinition, runId: string): Promise<RunSnapshot> { let snapshot: RunSnapshot | undefined; for (const step of workflow.steps) snapshot = await step.execute(runId); if (!snapshot) throw new Error(`Workflow "${workflow.name}" produced no snapshots`); return snapshot; }
export function subagentWorkflow(task: string, roleName: string, execute: WorkflowStep["execute"]): WorkflowDefinition { return { name: `subagent:${roleName}`, steps: [{ name: "delegate", execute: (runId) => execute(runId) }, { name: `task:${task.slice(0, 64)}`, execute }] }; }
export function reviewerJuryWorkflow(execute: WorkflowStep["execute"]): WorkflowDefinition { return { name: "reviewer-jury", steps: [{ name: "review", execute }] }; }
export function planWorkflow(_planContent: string, execute: WorkflowStep["execute"]): WorkflowDefinition { return { name: "plan", steps: [{ name: "plan", execute }, { name: "execute", execute }] }; }
export function reviewWorkflow(_reviewComments: string[], execute: WorkflowStep["execute"]): WorkflowDefinition { return { name: "review", steps: [{ name: "address-findings", execute }] }; }
