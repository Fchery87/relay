import { useEffect, useState } from "react";
import { MODEL_CATALOG } from "@relay/shared";

export type PlanArtifact = { content: string; revision: number; status: "draft" | "approved" };
export type PlanPhase = "planning" | "review" | "building" | "complete";

export function PlanPanel({ buildModelId, canConfigureModels, onApprove, onModelPairChange, onUpdateDraft, plan, planModelId, phase }: {
  buildModelId: string;
  canConfigureModels: boolean;
  onApprove(input: { content: string; expectedRevision: number }): Promise<unknown> | unknown;
  onModelPairChange(input: { buildModelId: string; planModelId: string }): Promise<unknown> | unknown;
  onUpdateDraft(input: { content: string; expectedRevision: number }): Promise<unknown> | unknown;
  plan: PlanArtifact | null;
  planModelId: string;
  phase: PlanPhase;
}) {
  const [draft, setDraft] = useState(plan?.content ?? "");
  const [pair, setPair] = useState({ buildModelId, planModelId });
  useEffect(() => setDraft(plan?.content ?? ""), [plan?.content]);
  useEffect(() => setPair({ buildModelId, planModelId }), [buildModelId, planModelId]);
  const canSelectModels = canConfigureModels && phase === "planning" && plan === null;
  return <section className="plan-panel">
    <header><h2>Plan</h2><span>{phase}</span></header>
    <div className="plan-models">
      <label>Planner<select disabled={!canSelectModels} onChange={(event) => { const next = { ...pair, planModelId: event.currentTarget.value }; setPair(next); void onModelPairChange(next); }} value={pair.planModelId}>{MODEL_CATALOG.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      <label>Builder<select disabled={!canSelectModels} onChange={(event) => { const next = { ...pair, buildModelId: event.currentTarget.value }; setPair(next); void onModelPairChange(next); }} value={pair.buildModelId}>{MODEL_CATALOG.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
    </div>
    {plan ? <div className="plan-artifact">
      {plan.status === "draft" && phase === "review" ? <textarea aria-label="Plan draft" onChange={(event) => setDraft(event.currentTarget.value)} value={draft} /> : <pre>{plan.content}</pre>}
      {plan.status === "draft" && phase === "review" ? <div className="plan-actions"><button onClick={() => void onUpdateDraft({ content: draft, expectedRevision: plan.revision })} type="button">Save draft</button><button onClick={() => void onApprove({ content: draft, expectedRevision: plan.revision })} type="button">Approve plan</button></div> : null}
    </div> : <p className="plan-state">The planner will produce a draft from your first message.</p>}
  </section>;
}
