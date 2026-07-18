import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CommandPalette, filterPaletteItems, type PaletteItem } from "./command-palette";

const items: PaletteItem[] = [
  { detail: "relay", id: "run:1", kind: "run", label: "Fix auth bug" },
  { detail: "photogenic", id: "run:2", kind: "run", label: "Landing page" },
  { id: "action:new-task", kind: "action", label: "New task in relay" },
  { id: "action:toggle-terminal", kind: "action", label: "Toggle terminal", shortcut: "⌘J" },
  { id: "action:settings-machines", kind: "action", label: "Settings → Machines" },
];

test("empty query returns everything capped, runs before actions", () => {
  const results = filterPaletteItems("", items);
  expect(results.length).toBe(items.length);
  expect(results[0]?.kind).toBe("run");
  expect(results.at(-1)?.kind).toBe("action");
});

test("matches case-insensitive subsequences and ranks runs first", () => {
  const results = filterPaletteItems("fix", items);
  expect(results.map((item) => item.id)).toEqual(["run:1"]);
  const auth = filterPaletteItems("AUTH", items);
  expect(auth.map((item) => item.id)).toEqual(["run:1"]);
  const toggles = filterPaletteItems("togter", items);
  expect(toggles.map((item) => item.id)).toEqual(["action:toggle-terminal"]);
});

test("caps results at twelve", () => {
  const many = Array.from({ length: 30 }, (_, index): PaletteItem => ({ id: `run:${index}`, kind: "run", label: `Run ${index}` }));
  expect(filterPaletteItems("run", many).length).toBe(12);
});

test("renders a dialog listbox with sections when open", () => {
  const markup = renderToStaticMarkup(<CommandPalette items={items} onClose={() => {}} onSelect={() => {}} open />);
  expect(markup).toContain('role="dialog"');
  expect(markup).toContain("RUNS");
  expect(markup).toContain("ACTIONS");
  expect(markup).toContain("Fix auth bug");
  expect(markup).toContain("⌘J");
});

test("renders nothing when closed", () => {
  expect(renderToStaticMarkup(<CommandPalette items={items} onClose={() => {}} onSelect={() => {}} open={false} />)).toBe("");
});
