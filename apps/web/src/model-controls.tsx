import { DEFAULT_MODEL_ID, MODEL_CATALOG, listThinkingLevels, type ThinkingLevel } from "@relay/shared";

export function ModelControls({ modelId, onChange, thinkingLevel }: {
  modelId: string;
  onChange(input: { modelId: string; thinkingLevel: ThinkingLevel }): Promise<unknown>;
  thinkingLevel: ThinkingLevel;
}) {
  const model = MODEL_CATALOG.models.find((entry) => entry.id === modelId) ?? MODEL_CATALOG.models.find((entry) => entry.id === DEFAULT_MODEL_ID);
  if (!model) throw new Error("Catalog default model is missing");
  const thinkingLevels = listThinkingLevels(model);
  return <div className="model-controls">
    <select aria-label="Model" onChange={(event) => {
      const nextModel = MODEL_CATALOG.models.find((entry) => entry.id === event.target.value);
      if (!nextModel) return;
      const nextThinking = listThinkingLevels(nextModel)[0] ?? "none";
      void onChange({ modelId: nextModel.id, thinkingLevel: nextThinking });
    }} value={model.id}>
      {MODEL_CATALOG.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
    </select>
    <select aria-label="Thinking level" onChange={(event) => void onChange({ modelId: model.id, thinkingLevel: parseThinkingLevel(event.target.value) })} value={thinkingLevels.includes(thinkingLevel) ? thinkingLevel : thinkingLevels[0]}>
      {thinkingLevels.map((level) => <option key={level} value={level}>{level[0]?.toUpperCase()}{level.slice(1)}</option>)}
    </select>
  </div>;
}

function parseThinkingLevel(value: string): ThinkingLevel {
  if (value === "none" || value === "low" || value === "medium" || value === "high") return value;
  throw new Error("Unknown thinking level");
}
