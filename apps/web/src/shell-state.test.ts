import { expect, test } from "bun:test";

import { loadShellPanels, saveShellPanels, SHELL_PANELS_STORAGE_KEY, shortcutForEvent } from "./shell-state";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    store,
  };
}

test("defaults to sidebar and inspector open, terminal closed", () => {
  expect(loadShellPanels(memoryStorage())).toEqual({ inspector: true, sidebar: true, terminal: false });
});

test("tolerates garbage and partial stored values", () => {
  expect(loadShellPanels(memoryStorage({ [SHELL_PANELS_STORAGE_KEY]: "not json" }))).toEqual({ inspector: true, sidebar: true, terminal: false });
  expect(loadShellPanels(memoryStorage({ [SHELL_PANELS_STORAGE_KEY]: '{"terminal":true}' }))).toEqual({ inspector: true, sidebar: true, terminal: true });
  expect(loadShellPanels(memoryStorage({ [SHELL_PANELS_STORAGE_KEY]: '{"sidebar":"yes"}' }))).toEqual({ inspector: true, sidebar: true, terminal: false });
});

test("round-trips saved panel state", () => {
  const storage = memoryStorage();
  saveShellPanels(storage, { inspector: false, sidebar: false, terminal: true });
  expect(loadShellPanels(storage)).toEqual({ inspector: false, sidebar: false, terminal: true });
});

test("maps mod+B/J/I/K to panel and palette shortcuts", () => {
  expect(shortcutForEvent({ ctrlKey: false, key: "b", metaKey: true })).toBe("sidebar");
  expect(shortcutForEvent({ ctrlKey: true, key: "B", metaKey: false })).toBe("sidebar");
  expect(shortcutForEvent({ ctrlKey: true, key: "j", metaKey: false })).toBe("terminal");
  expect(shortcutForEvent({ ctrlKey: false, key: "i", metaKey: true })).toBe("inspector");
  expect(shortcutForEvent({ ctrlKey: true, key: "k", metaKey: false })).toBe("palette");
});

test("ignores unmodified keys and unknown combos", () => {
  expect(shortcutForEvent({ ctrlKey: false, key: "b", metaKey: false })).toBeUndefined();
  expect(shortcutForEvent({ ctrlKey: true, key: "x", metaKey: false })).toBeUndefined();
  expect(shortcutForEvent({ ctrlKey: false, key: "k", metaKey: false })).toBeUndefined();
});
