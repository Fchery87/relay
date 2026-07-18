import { useCallback, useState } from "react";

export type ShellPanel = "sidebar" | "terminal" | "inspector";
export type ShellPanels = Readonly<Record<ShellPanel, boolean>>;
export type ShellShortcut = ShellPanel | "palette";

export const SHELL_PANELS_STORAGE_KEY = "relay.shell.panels";

const DEFAULT_PANELS: ShellPanels = { inspector: true, sidebar: true, terminal: false };

export function loadShellPanels(storage: Pick<Storage, "getItem">): ShellPanels {
  const raw = storage.getItem(SHELL_PANELS_STORAGE_KEY);
  if (raw === null) return DEFAULT_PANELS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PANELS;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_PANELS;
  const stored: Partial<Record<ShellPanel, unknown>> = parsed;
  return {
    inspector: typeof stored.inspector === "boolean" ? stored.inspector : DEFAULT_PANELS.inspector,
    sidebar: typeof stored.sidebar === "boolean" ? stored.sidebar : DEFAULT_PANELS.sidebar,
    terminal: typeof stored.terminal === "boolean" ? stored.terminal : DEFAULT_PANELS.terminal,
  };
}

export function saveShellPanels(storage: Pick<Storage, "setItem">, panels: ShellPanels): void {
  storage.setItem(SHELL_PANELS_STORAGE_KEY, JSON.stringify(panels));
}

const SHORTCUT_KEYS: Readonly<Record<string, ShellShortcut>> = {
  b: "sidebar",
  i: "inspector",
  j: "terminal",
  k: "palette",
};

export function shortcutForEvent(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">): ShellShortcut | undefined {
  if (!event.metaKey && !event.ctrlKey) return undefined;
  return SHORTCUT_KEYS[event.key.toLowerCase()];
}

export function useShellState(): {
  paletteOpen: boolean;
  panels: ShellPanels;
  setPaletteOpen: (open: boolean) => void;
  toggle: (panel: ShellPanel) => void;
} {
  const [panels, setPanels] = useState<ShellPanels>(() => loadShellPanels(window.localStorage));
  const [paletteOpen, setPaletteOpen] = useState(false);

  const toggle = useCallback((panel: ShellPanel) => {
    setPanels((current) => {
      const next = { ...current, [panel]: !current[panel] };
      saveShellPanels(window.localStorage, next);
      return next;
    });
  }, []);

  return { paletteOpen, panels, setPaletteOpen, toggle };
}
