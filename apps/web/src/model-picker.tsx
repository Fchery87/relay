import { useEffect, useRef, useState } from "react";
import { DEFAULT_MODEL_ID, listThinkingLevels, MODEL_CATALOG, type ThinkingLevel } from "@relay/shared";

type CatalogModel = (typeof MODEL_CATALOG.models)[number];

export function groupModelsByProvider(models: ReadonlyArray<CatalogModel>): Array<{ models: CatalogModel[]; provider: string }> {
  const groups: Array<{ models: CatalogModel[]; provider: string }> = [];
  for (const model of models) {
    const group = groups.find((entry) => entry.provider === model.provider);
    if (group) group.models.push(model);
    else groups.push({ models: [model], provider: model.provider });
  }
  return groups;
}

export function ModelPicker({
  defaultOpen = false,
  disabled = false,
  modelId,
  onChange,
  thinkingLevel,
}: {
  defaultOpen?: boolean;
  disabled?: boolean;
  modelId: string;
  onChange: (input: { modelId: string; thinkingLevel: ThinkingLevel }) => Promise<unknown>;
  thinkingLevel: ThinkingLevel;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const containerRef = useRef<HTMLDivElement>(null);
  const model = MODEL_CATALOG.models.find((entry) => entry.id === modelId) ?? MODEL_CATALOG.models.find((entry) => entry.id === DEFAULT_MODEL_ID);
  if (!model) throw new Error("Catalog default model is missing");
  const activeThinking = listThinkingLevels(model).includes(thinkingLevel) ? thinkingLevel : listThinkingLevels(model)[0] ?? "none";

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && event.target instanceof Node && !containerRef.current.contains(event.target)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className="composer-picker" onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Model"
        className="composer-picker-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span aria-hidden="true">◈</span> {model.name} <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="composer-popover" role="listbox" aria-label="Models">
          {groupModelsByProvider(MODEL_CATALOG.models).map((group) => (
            <div className="composer-popover-group" key={group.provider}>
              <p className="composer-popover-caption">{group.provider.toUpperCase()}</p>
              {group.models.map((entry) => (
                <button
                  aria-selected={entry.id === model.id}
                  className="composer-popover-option"
                  key={entry.id}
                  onClick={() => {
                    const nextThinking = listThinkingLevels(entry).includes(activeThinking) ? activeThinking : listThinkingLevels(entry)[0] ?? "none";
                    void onChange({ modelId: entry.id, thinkingLevel: nextThinking });
                    setOpen(false);
                  }}
                  role="option"
                  type="button"
                >
                  {entry.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
