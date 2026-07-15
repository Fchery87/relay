import type { KeyboardEvent } from "react";

export type WorkbenchTab = "terminal" | "changes" | "plan" | "agents" | "connections";

const WORKBENCH_TABS: ReadonlyArray<{ id: WorkbenchTab; label: string }> = [
  { id: "terminal", label: "Terminal" },
  { id: "changes", label: "Changes" },
  { id: "plan", label: "Plan" },
  { id: "agents", label: "Agents" },
  { id: "connections", label: "Connections" },
];

export function WorkbenchTabs({
  active,
  onChange,
  showPlan,
}: {
  active: WorkbenchTab;
  onChange: (tab: WorkbenchTab) => void;
  showPlan: boolean;
}) {
  const visibleTabs = WORKBENCH_TABS.filter((tab) => tab.id !== "plan" || showPlan);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % visibleTabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + visibleTabs.length) % visibleTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = visibleTabs.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    const nextTab = visibleTabs[nextIndex];
    if (!nextTab) return;
    onChange(nextTab.id);
    document.getElementById(`workbench-tab-${nextTab.id}`)?.focus();
  }

  return (
    <div aria-label="Workbench tools" className="workbench-tabs" role="tablist">
      {visibleTabs.map((tab, index) => (
        <button
          aria-controls="workbench-panel"
          aria-selected={active === tab.id}
          id={`workbench-tab-${tab.id}`}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          role="tab"
          tabIndex={active === tab.id ? 0 : -1}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
