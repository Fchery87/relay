# Brass & Patina UI Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restyle and restructure the Relay web app into a lean, T3-inspired shell — neutral near-black canvas, patina (verdigris) interactive accent, brass reserved for "needs you" signals, three toggleable panels, in-composer model/access selectors, project-first sidebar with attention inbox, a `/settings` route tree, and a ⌘K command palette.

**Architecture:** All color is CSS-variable-driven (`apps/web/src/app.css` `:root`), so the palette is swapped at the token layer first. The shell is rebuilt around a `useShellState` hook (panel open/closed + localStorage + keyboard shortcuts). Convex gets one widen (`threads.permissionProfile`) and one new query file (`convex/attention.ts`). Existing panels (GovernancePanel, SubagentPanel, McpServerPanel, UsagePanel, HandoffTrace, DensityControl, PairingPanel) are relocated, not rewritten.

**Tech Stack:** React 19, TanStack Router, Convex 1.31 (legacy transport via `run-data.ts`), bun test, Geist/Geist Mono, plain CSS.

**Glossary (CONTEXT.md):** *patina* = interactive; *brass* = the agent needs you; *needs-you item*; *attention inbox*. Never mix the two metals' meanings.

**Constraints:**
- Working tree is already dirty with unrelated daemon/kernel work — **stage files explicitly per commit; never `git add -A`. Do not commit unless the user asks.**
- Convex schema discipline is widen-only (see `docs/adr/0002`); `permissionProfile` must be `v.optional`.
- Emil rules: no animation on keyboard-initiated toggles; transitions ≤250ms, `transform`/`opacity` only, `ease-out`; buttons get `:active { transform: scale(0.97) }`; popovers scale from trigger origin at ~`scale(0.97)`+opacity, never `scale(0)`.
- Verify with: `cd apps/web && bun run typecheck && bun test`, `cd convex && bun run test:convex` after Convex tasks.

---

## Task 1: Palette tokens — brass & patina

**Files:**
- Modify: `apps/web/src/app.css` (`:root` block, lines ~1–65)
- Test: `apps/web/src/design-system.test.tsx` (update expected token values)

New token values (replacing the green-graphite ladder):

```css
:root {
  color-scheme: dark;

  --color-canvas: #0A0A0B;
  --color-surface: #111213;
  --color-surface-raised: #17181A;
  --color-surface-hover: #1D1F21;
  --color-border: #26282B;
  --color-border-strong: #34373B;
  --color-on-surface: #EDEEEC;
  --color-on-surface-muted: #A3A7A3;
  --color-on-surface-subtle: #6F7472;

  /* patina = interactive */
  --color-primary: #6FBFB4;
  --color-on-primary: #06110F;
  --color-accent: #8FD4C9;
  --color-on-accent: #06110F;

  /* brass = the agent needs you */
  --color-brass: #C7A95D;
  --color-on-brass: #171207;
  --color-brass-soft: rgba(199, 169, 93, 0.14);

  --color-success: #77A681;
  --color-on-success: #07130B;
  --color-warning: #C58D58;
  --color-on-warning: #180D05;
  --color-error: #C8726B;
  --color-on-error: #190706;
  --color-info: #7E9F97;
  --color-on-info: #071310;
  --color-terminal: #060708;
  --color-terminal-text: #D3D7D3;
  /* …typography/spacing tokens unchanged… */
  --ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
}
```

**Steps:**
1. Read `design-system.test.tsx`; update any asserted hex values to the new tokens (add assertions for `--color-brass`).
2. Run `bun test design-system` → expect FAIL (old values).
3. Apply the `:root` edit. Grep `app.css` for hardcoded hexes outside `:root` (`grep -n '#[0-9A-Fa-f]\{6\}' app.css`) and migrate strays to tokens.
4. Re-run test → PASS. Full `bun test` to catch collateral.
5. Re-point existing brass usages: `HandoffTrace`, approval cards, checkpoint markers, `.causal-contact` styles must use `--color-brass`, not `--color-primary` (grep `.handoff`, `.approval`, `.checkpoint`, `.causal-contact` in app.css).

## Task 2: ADR + design.md rewrite

**Files:**
- Create: `docs/adr/0004-brass-and-patina-palette.md` (context: T3-inspired restyle; decision: patina interactive / brass attention on neutral near-black; alternatives: Tailwind-blue clone, brass-primary retained; consequences: full-token swap, semantic color contract in CONTEXT.md)
- Modify: `docs/design.md` — update frontmatter colors to Task 1 values (add `brass`, `on-brass`); rewrite **Colors** prose for the two-metals story; update **Layout** prose for the new shell (slim 40px header, three toggles, Session/Changes tabs, terminal drawer, `/settings` routes); update **Components** prose (composer owns model+access pickers).

## Task 3: Shell state hook + keyboard shortcuts

**Files:**
- Create: `apps/web/src/shell-state.ts`
- Test: `apps/web/src/shell-state.test.ts`

API (TDD — write tests first):

```ts
export type ShellPanels = { sidebar: boolean; terminal: boolean; inspector: boolean };
export function loadShellPanels(storage: Pick<Storage, "getItem">): ShellPanels; // defaults { sidebar: true, terminal: false, inspector: true }; tolerates garbage JSON
export function saveShellPanels(storage: Pick<Storage, "setItem">, panels: ShellPanels): void; // key "relay.shell.panels"
export function shortcutForEvent(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">): "sidebar" | "terminal" | "inspector" | "palette" | undefined;
// mod+B / mod+J / mod+I / mod+K (mod = meta OR ctrl)
export function useShellState(): { panels; toggle(panel): void; paletteOpen; setPaletteOpen };
```

Tests: default load, garbage tolerance, round-trip, each shortcut mapping, plain keys → undefined. Pure functions tested directly; hook wiring is exercised via app tests.

## Task 4: Router — settings routes + narrowed search

**Files:**
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/src/router.test.tsx`

Changes:
- `WorkspaceSearch.view` narrows to `"session" | "changes" | "plan"`; legacy values (`terminal`, `agents`, `connections`) validate to `{}`.
- Add routes: `/settings`, `/settings/$section` (component provided by app), keeping Workspace routes.
- Tests: legacy view param drops; `/settings/machines` resolves.

## Task 5: Convex — permissionProfile widen

**Files:**
- Modify: `convex/schema.ts` (threads table), `convex/conversations.ts`
- Test: `convex/conversations.convex.test.ts`

1. Schema: add `permissionProfile: v.optional(v.union(v.literal("read-only"), v.literal("workspace-write"), v.literal("full-access")))` to `threads`.
2. `createThread`: accept optional `permissionProfile`, default `"workspace-write"` on insert.
3. New mutation `updatePermissionProfile({ threadId, permissionProfile })`: `requireOwnedThread`; reject with `ConvexError` when `status` is `running`/`awaiting-approval`/`restoring` (locked mid-turn).
4. Tests first: create-with-profile, default, update-when-idle, reject-when-running. Run `cd convex && bun run test:convex`.

## Task 6: Convex — attention inbox query

**Files:**
- Create: `convex/attention.ts`
- Test: `convex/attention.convex.test.ts`

`export const listNeedsYou = queryGeneric({ args: {}, ... })`:
- For the authed user: projects → threads (`by_project`), classify each thread into needs-you kinds: `approval` (status `awaiting-approval`), `plan-review` (planPhase `review`), `failed` (status `failed`), `elicitation` (pending row in `mcpElicitations` `by_thread`, status field pending — check table shape before writing).
- Return `Array<{ threadId, projectId, title, kind, projectName }>`, bounded (`take(50)` per project, cap total 100).
- Tests: each kind classifies; healthy threads excluded; other users' threads excluded (follow patterns in `approvals.convex.test.ts`).

## Task 7: Sidebar — project-first tree + attention inbox

**Files:**
- Create: `apps/web/src/workspace-sidebar.tsx`, test `workspace-sidebar.test.tsx`
- Delete (after cutover in Task 10): `apps/web/src/machine-sidebar.tsx`, `machine-sidebar.test.tsx`

Structure: brand row (+ collapse affordance) → search button (label "Search", kbd "⌘K", opens palette via prop) → **Needs You** section (brass `◆` badge + rows from `listNeedsYou`, hidden when empty; row click navigates to thread) → **Projects** (collapsible per project: name + machine presence dot + machine name `title` attr; nested run rows with status dots, active run `aria-current="page"`; `+ New task` / `New plan` per project) → footer: Settings link (`/settings`).
`MachineSummary` type moves here (re-export to keep `app.tsx` import stable or update import).
Tests: renders projects/runs, attention section hidden when empty, machine dot present, revoke absent (moved to settings).

## Task 8: Composer — model picker + access picker

**Files:**
- Create: `apps/web/src/model-picker.tsx` (+ test), `apps/web/src/access-picker.tsx` (+ test), `apps/web/src/composer.tsx` (+ test)
- Delete: `apps/web/src/model-controls.tsx` (+ test) after cutover

`ModelPicker`: trigger button `◈ {model.name} · {thinkingLevel}`; popover lists `MODEL_CATALOG.models` grouped by `provider` (uppercase caption headers), thinking-level segmented row for the active model at the bottom. Popover = absolutely-positioned listbox (`role="listbox"`, arrow-key nav, Escape closes, focus returns to trigger); CSS `transform-origin: bottom left; @starting-style { opacity: 0; transform: scale(0.97) }`, 150ms `var(--ease-out-strong)`.
`AccessPicker`: three options with one-line descriptions (`read-only` "Inspect only", `workspace-write` "Edit inside the worktree · network denied", `full-access` "⚠ Network enabled"); `disabled` prop when turn running (locked mid-turn); warning styling (not brass) on full-access.
`Composer`: extract the `<form className="composer">` from `thread-view.tsx`; footer = attach ⊕ (icon button, existing file-input logic) · ModelPicker · AccessPicker · send `➤` (patina primary). Delete the "Directive" label, static context spans, and receipt paragraph (receipt becomes transient `aria-live` text that auto-clears).
Props in, callbacks out — no Convex imports in these three files.

## Task 9: Terminal drawer + inspector

**Files:**
- Create: `apps/web/src/terminal-drawer.tsx`, `apps/web/src/inspector.tsx` (+ smoke tests)

`TerminalDrawer`: bottom drawer inside the center column (240–320px), contains existing `ThreadActivity` + `ThreadTerminal` + command form (moved from thread-view). Slides with `transform: translateY` 200ms `var(--ease-drawer)`; **no transition when toggled via keyboard** (pass `instant` flag from shortcut path).
`Inspector`: right panel, sections in order: **Stage** (existing `HandoffTrace`, brass), **Environment** (machine/repo/branch/access facts), **Needs you** (pending approvals count → jumps to Session), **Agents** (live `subagentRuns` list), **Usage** (existing `UsagePanel` with budget editor). Replaces `InspectorContent`; `ContextInspector` modal remains the <1040px presentation.

## Task 10: Thread-view + app shell cutover

**Files:**
- Modify: `apps/web/src/thread-view.tsx`, `apps/web/src/app.tsx`, `apps/web/src/workbench-tabs.tsx`
- Modify tests: `workbench-navigation.test.tsx`, `agent-workspace.test.tsx`, `app`-level tests
- Delete: `machine-sidebar.tsx`(+test), `model-controls.tsx`(+test)

- `workbench-tabs.tsx`: tabs = Session, Changes (+ Plan when `showPlan`). Terminal/Agents/Connections removed.
- `thread-view.tsx`: header → single 40px `.run-bar` (title, status dot + stage text — brass class when `awaiting-approval`/plan review; Stop while running; terminal + inspector toggle buttons). Delete `run-context-facts`, `session-summary`, run-switcher select, usage/model controls from header (new homes: Tasks 7–9). Terminal tab content → `TerminalDrawer`; composer → `Composer` with `updatePermissionProfile` wiring; keep Session/Changes/Plan canvases.
- `app.tsx`: shell grid `[sidebar] [main] [inspector]` driven by `useShellState`; workspace header deleted (sign-out moves to Settings); global key handler dispatches `shortcutForEvent`; route to `SettingsView` under `/settings`; `WorkspaceSidebar` replaces `MachineSidebar`.
- Grid: `grid-template-columns: auto 1fr auto`; sidebar/inspector collapse to width 0 with `visibility: hidden` (no layout animation on keyboard toggle).

## Task 11: Command palette

**Files:**
- Create: `apps/web/src/command-palette.tsx`, test `command-palette.test.tsx`

Pure helper `filterPaletteItems(query, items)` (case-insensitive subsequence match, runs before actions, cap 12) — TDD this. Component: `role="dialog"` + listbox, opens from `useShellState.paletteOpen`, ⌘K/Escape close, arrow/Enter select. Items: all runs across projects (`● title · project`), actions (New task per project, New plan, Toggle terminal/inspector/sidebar, Open settings sections). Overlay: centered top-third, `@starting-style` fade+`scale(0.98)` 150ms; **no exit animation**.

## Task 12: Settings routes

**Files:**
- Create: `apps/web/src/settings-view.tsx` (+ `settings-view.test.tsx`); optional split: `settings/` folder if any section exceeds ~150 lines

Section rail (GLOBAL: Account, Appearance, Models, Machines, Agents, Shortcuts · PROJECT: picker + Connections, Budgets) with `aria-current` on active section; content per section reuses existing components:
- Account: user email + Sign out (moved from header).
- Appearance: `DensityControl`.
- Models: default model + thinking (session-level display; defaults read from `MODEL_CATALOG`), plan/build pair note.
- Machines: list w/ presence, platform, capability ceiling, Revoke (moved from sidebar), `PairingPanel` for new machines.
- Agents: `SubagentPanel` roles editor (runs list stays in Inspector).
- Shortcuts: static table (⌘B/⌘J/⌘I/⌘K, ⌘Enter send).
- Connections: `McpServerPanel` scoped to picked project.
- Budgets: budget editor (from `UsagePanel` logic) per project thread defaults — display-only if no backing mutation exists; **do not invent schema**.
Route wiring from Task 4; deep link `/settings/machines` must render Machines directly.

## Task 13: New-shell CSS

**Files:**
- Modify: `apps/web/src/app.css`

Add styles: `.run-bar` (40px, border-bottom), `.sidebar-tree` (rows `--row-height`, patina `aria-current` contact line 2px inset-left), `.needs-you` (brass badge `--color-brass-soft` bg), `.composer-popover` (raised surface, `--rounded-md`, one short neutral shadow `0 4px 16px rgba(0,0,0,0.4)`), `.terminal-drawer`, `.inspector` (borders, not shadows), `.command-palette` overlay, `.settings-layout` (rail + content grid). Buttons: add `button:active { transform: scale(0.97) }` with `transition: transform 120ms var(--ease-out-strong)` (respect `prefers-reduced-motion`). Remove dead CSS for deleted surfaces (`.operations-nav`, `.fleet-summary`, `.session-summary`, `.run-context-facts`, `.thread-toolbar`, old `.workbench-tabs` entries for removed tabs).

## Task 14: Full verification

1. `cd apps/web && bun run typecheck && bun test` — all green.
2. `cd convex && bun run test:convex` — all green.
3. `bun run bundle:check` from repo root.
4. Launch `bun run web:dev` + verify shell toggles, composer popovers, palette, `/settings/machines` deep link in browser (use /verify flow).
5. Grep for orphans: `grep -rn "MachineSidebar\|ModelControls\|operations-nav" apps/web/src` → no hits.
