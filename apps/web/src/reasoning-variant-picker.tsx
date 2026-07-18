import { useEffect, useRef, useState } from "react";
import { listThinkingLevels, MODEL_CATALOG, type ThinkingLevel } from "@relay/shared";

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
  none: "Standard",
  low: "Low",
  medium: "Medium",
  high: "High",
};

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  none: "No reasoning overhead",
  low: "Brief reasoning step",
  medium: "Balanced depth",
  high: "Extended reasoning",
};

export function ReasoningVariantPicker({
  defaultOpen = false,
  disabled = false,
  modelId,
  onChange,
  thinkingLevel,
}: {
  defaultOpen?: boolean;
  disabled?: boolean;
  modelId: string;
  onChange: (thinkingLevel: ThinkingLevel) => Promise<unknown>;
  thinkingLevel: ThinkingLevel;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const containerRef = useRef<HTMLDivElement>(null);
  const model = MODEL_CATALOG.models.find((entry) => entry.id === modelId) ?? MODEL_CATALOG.models.find((entry) => entry.id === MODEL_CATALOG.defaultModelId);
  if (!model) throw new Error("Catalog default model is missing");
  const levels = listThinkingLevels(model);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && event.target instanceof Node && !containerRef.current.contains(event.target)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Models with a single thinking level (e.g. DeepSeek Reasoner, always-on)
  // have no variant to choose — hide the picker.
  if (levels.length <= 1) return null;

  const activeLevel = levels.includes(thinkingLevel) ? thinkingLevel : levels[0] ?? "none";

  return (
    <div className="composer-picker" onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Reasoning variant"
        className="composer-picker-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        title={disabled ? "Locked while a turn is running" : undefined}
        type="button"
      >
        <span aria-hidden="true">✦</span> {LEVEL_LABELS[activeLevel]} <span aria-hidden="true">▾</span>
      </button>
      {open && !disabled ? (
        <div className="composer-popover" role="listbox" aria-label="Reasoning variants">
          {levels.map((level) => (
            <button
              aria-selected={level === activeLevel}
              className="composer-popover-option"
              key={level}
              onClick={() => {
                void onChange(level);
                setOpen(false);
              }}
              role="option"
              type="button"
            >
              <strong>{LEVEL_LABELS[level]}</strong>
              <small>{LEVEL_DESCRIPTIONS[level]}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
