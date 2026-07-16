import type { Command } from "@relay/contracts";
import type { RunSnapshot } from "@relay/contracts";

// ---------------------------------------------------------------------------
// Orchestrated workflow — every agent workflow (subagent, review, plan, MCP)
// routes through this abstraction so the engine is the single state owner.
// ---------------------------------------------------------------------------

export type WorkflowStep = {
  readonly name: string;
  /** Submit a command and wait for the resulting snapshot. */
  readonly execute: (runId: string) => Promise<RunSnapshot>;
};

export type WorkflowDefinition = {
  readonly name: string;
  readonly steps: ReadonlyArray<WorkflowStep>;
};

/**
 * Executes a workflow step-by-step, submitting commands through the engine
 * and waiting for each step's snapshot before proceeding.
 */
export async function executeWorkflow(
  workflow: WorkflowDefinition,
  runId: string,
): Promise<RunSnapshot> {
  let lastSnapshot: RunSnapshot | undefined;

  for (const step of workflow.steps) {
    lastSnapshot = await step.execute(runId);
  }

  if (!lastSnapshot) {
    throw new Error(`Workflow "${workflow.name}" produced no snapshots`);
  }
  return lastSnapshot;
}

// ---------------------------------------------------------------------------
// Workflow definitions (stubs — real impls wire into existing daemon code).
// ---------------------------------------------------------------------------

export function subagentWorkflow(task: string, roleName: string): WorkflowDefinition {
  return {
    name: `subagent:${roleName}`,
    steps: [
      {
        name: "send-subagent-turn",
        execute: async (_runId) => {
          // In real impl: submits a turn.send command with the task + role caps
          // and waits for turn.completed via the orchestration engine.
          throw new Error("Subagent workflow requires orchestration engine wiring (ticket 12 full)");
        },
      },
    ],
  };
}

export function reviewWorkflow(reviewComments: string[]): WorkflowDefinition {
  return {
    name: "review",
    steps: [
      {
        name: "address-findings",
        execute: async (_runId) => {
          throw new Error("Review workflow requires orchestration engine wiring (ticket 12 full)");
        },
      },
    ],
  };
}

export function reviewerJuryWorkflow(): WorkflowDefinition {
  return {
    name: "reviewer-jury",
    steps: [
      {
        name: "run-reviewer",
        execute: async (_runId) => {
          // Reviewer + reviewer-security, different models → P0–P3 comments
          throw new Error("Reviewer jury requires orchestration engine wiring (ticket 12 full)");
        },
      },
    ],
  };
}

export function planWorkflow(planContent: string): WorkflowDefinition {
  return {
    name: "plan",
    steps: [
      {
        name: "execute-plan",
        execute: async (_runId) => {
          throw new Error("Plan workflow requires orchestration engine wiring (ticket 12 full)");
        },
      },
    ],
  };
}
