export type PlanDecision = Readonly<{ approved: boolean; revision: number; content: string; requestedBy: string }>;
export function validatePlanDecision(decision: PlanDecision, expectedRevision: number): void { if (decision.revision !== expectedRevision) throw new Error("Stale plan revision"); if (!decision.content.trim()) throw new Error("Plan content is required"); }
