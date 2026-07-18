import { useEffect, useMemo, useRef, useState } from "react";

export type PaletteItem = {
  detail?: string;
  id: string;
  kind: "run" | "action";
  label: string;
  shortcut?: string;
};

const MAX_RESULTS = 12;

function isSubsequence(query: string, target: string): boolean {
  let index = 0;
  for (const char of target) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return query.length === 0;
}

export function filterPaletteItems(query: string, items: ReadonlyArray<PaletteItem>): PaletteItem[] {
  const needle = query.trim().toLowerCase();
  const matches = items.filter((item) => isSubsequence(needle, `${item.label} ${item.detail ?? ""}`.toLowerCase()));
  const runs = matches.filter((item) => item.kind === "run");
  const actions = matches.filter((item) => item.kind === "action");
  return [...runs, ...actions].slice(0, MAX_RESULTS);
}

export function CommandPalette({
  items,
  onClose,
  onSelect,
  open,
}: {
  items: ReadonlyArray<PaletteItem>;
  onClose: () => void;
  onSelect: (item: PaletteItem) => void;
  open: boolean;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => filterPaletteItems(query, items), [items, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  const active = results[Math.min(activeIndex, results.length - 1)];
  const runs = results.filter((item) => item.kind === "run");
  const actions = results.filter((item) => item.kind === "action");

  function choose(item: PaletteItem | undefined) {
    if (!item) return;
    onSelect(item);
    onClose();
  }

  function renderSection(caption: string, sectionItems: PaletteItem[]) {
    if (sectionItems.length === 0) return null;
    return (
      <div className="palette-section">
        <p className="palette-caption">{caption}</p>
        {sectionItems.map((item) => (
          <button
            aria-selected={item.id === active?.id}
            className="palette-option"
            key={item.id}
            onClick={() => choose(item)}
            onPointerMove={() => setActiveIndex(results.indexOf(item))}
            role="option"
            type="button"
          >
            <span className="palette-label">{item.label}</span>
            {item.detail ? <small className="palette-detail">{item.detail}</small> : null}
            {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="palette-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div aria-label="Command palette" className="command-palette" role="dialog">
        <input
          aria-label="Search runs and actions"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => Math.min(current + 1, results.length - 1)); }
            if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => Math.max(current - 1, 0)); }
            if (event.key === "Enter") { event.preventDefault(); choose(active); }
          }}
          placeholder="Search runs, projects, actions…"
          ref={inputRef}
          value={query}
        />
        <div className="palette-results" role="listbox" aria-label="Results">
          {results.length === 0 ? <p className="palette-empty">No matches.</p> : null}
          {renderSection("RUNS", runs)}
          {renderSection("ACTIONS", actions)}
        </div>
      </div>
    </div>
  );
}
