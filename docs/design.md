---
version: alpha
name: Relay Switchboard
description: A dark, signal-led agent operations workspace for directing durable software tasks across machines, runs, agents, and artifacts.
colors:
  canvas: "#0A0A0B"
  surface: "#111213"
  surface-raised: "#17181A"
  surface-hover: "#1D1F21"
  border: "#26282B"
  border-strong: "#34373B"
  on-surface: "#EDEEEC"
  on-surface-muted: "#A3A7A3"
  on-surface-subtle: "#6F7472"
  primary: "#6FBFB4"
  on-primary: "#06110F"
  accent: "#8FD4C9"
  on-accent: "#06110F"
  brass: "#C7A95D"
  on-brass: "#171207"
  success: "#77A681"
  on-success: "#07130B"
  warning: "#C58D58"
  on-warning: "#180D05"
  error: "#C8726B"
  on-error: "#190706"
  info: "#7E9F97"
  on-info: "#071310"
  terminal: "#060708"
  terminal-text: "#D3D7D3"
typography:
  h1:
    fontFamily: "Geist, Geist Sans, sans-serif"
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
  h2:
    fontFamily: "Geist, Geist Sans, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: -0.015em
  h3:
    fontFamily: "Geist, Geist Sans, sans-serif"
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Geist, Geist Sans, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  body-strong:
    fontFamily: "Geist, Geist Sans, sans-serif"
    fontSize: 14px
    fontWeight: 550
    lineHeight: 1.5
  label:
    fontFamily: "Geist, Geist Sans, sans-serif"
    fontSize: 12px
    fontWeight: 550
    lineHeight: 1.4
  caption:
    fontFamily: "Geist, Geist Sans, sans-serif"
    fontSize: 11px
    fontWeight: 450
    lineHeight: 1.45
    fontFeature: "'tnum' 1"
  mono:
    fontFamily: "Geist Mono, monospace"
    fontSize: 13px
    fontWeight: 450
    lineHeight: 1.55
    fontFeature: "'tnum' 1, 'ss01' 1"
  mono-small:
    fontFamily: "Geist Mono, monospace"
    fontSize: 11px
    fontWeight: 450
    lineHeight: 1.5
    fontFeature: "'tnum' 1, 'ss01' 1"
rounded:
  none: 0px
  xs: 3px
  sm: 5px
  md: 7px
  lg: 10px
  full: 999px
spacing:
  0: 0px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  5: 24px
  6: 32px
  control-compact: 32px
  control-comfortable: 40px
  row-compact: 28px
  row-comfortable: 36px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "{spacing.2} {spacing.3}"
    height: "{spacing.control-compact}"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "{spacing.2} {spacing.3}"
    height: "{spacing.control-compact}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "{spacing.2} {spacing.3}"
    height: "{spacing.control-compact}"
  button-danger:
    backgroundColor: "{colors.error}"
    textColor: "{colors.on-error}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "{spacing.2} {spacing.3}"
    height: "{spacing.control-compact}"
  input:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "{spacing.2} {spacing.3}"
    height: "{spacing.control-compact}"
  composer:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "{spacing.4}"
    height: 120px
  navigation-item:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "{spacing.1} {spacing.2}"
    height: "{spacing.row-compact}"
  navigation-item-active:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.sm}"
    padding: "{spacing.1} {spacing.2}"
    height: "{spacing.row-compact}"
  operation-card:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
  workspace-pane:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "{spacing.4}"
---

# Relay Switchboard Design System

## Overview

Relay is an agent operations workspace for experienced developers who direct durable software tasks across local machines, repositories, worktrees, models, tools, and review boundaries. Its identity is the switchboard: the active task is the primary object; runs carry execution; agents and tools produce inspectable events and artifacts; machines remain visible as execution authority without dominating navigation. The interface should feel composed, exact, and quietly mechanical rather than futuristic. Relay's brass causal contacts and mineral graphite palette make the system its own. Relay must never resemble a theatrical AI control room, a consumer chat application, or a file-first IDE with chat attached.

## Colors

The palette tells one story in two states of the same metal (ADR 0004). The canvas is a neutral near-black ladder — no green tint, no blue tint — so the two semantic metals carry all meaning. **Patina** (verdigris, `primary`/`accent`) is the metal aged and means *interactive*: focus rings, links, selection, primary buttons, send. **Brass** is the metal polished and means *the agent needs you*: pending approvals, the handoff trace, checkpoint markers, the attention inbox, and the Relay mark itself. Neither metal may borrow the other's meaning, and no other color may borrow either. Warning is reserved for genuine risk (full-access network warnings, git impact), not for approvals. Success, warning, error, and info remain muted operational signals that must include text or an icon whenever meaning matters. All specified text pairs meet WCAG AA, and subdued text never carries critical instructions by itself.

## Typography

Geist Sans provides a compact, contemporary voice for navigation, messages, forms, and settings, while Geist Mono carries the machine layer: commands, paths, identifiers, durations, token counts, logs, diffs, and code. The 22-to-16-to-13 heading progression creates audible hierarchy without turning an internal tool into a presentation surface. H1 labels the active workspace or thread, H2 divides major surfaces, and H3 names local operations. Caption and mono styles use tabular figures so changing counts and durations remain visually stable. Avoid uppercase tracking, decorative display type, and mixing mono into ordinary prose.

## Layout

Relay uses a lean three-toggle shell around one calm canvas: a collapsible project-first left sidebar (search/⌘K, the brass attention inbox, projects with runs nested, Settings pinned at the bottom), a single 40-pixel run bar (sidebar toggle, task title, status plus current stage — brass when blocked on the operator — Stop while running, terminal and inspector toggles), the central task canvas with only Session and Changes tabs (Plan appears on plan runs), a toggleable right inspector (handoff trace, environment facts, needs-you summary, live agents, usage and budget), and a toggleable bottom terminal drawer. The composer owns run configuration: attach, the provider-grouped model picker with thinking level, the permission-profile picker (locked mid-turn), and send. The default canvas is Session—not Conversation—and integrates operator directives, agent output, approvals, checkpoints, and meaningful activity. Request, Plan, Execute, Review, and Deliver are subtle projections of real run state surfaced in the inspector's handoff trace rather than a manually advanced linear wizard. Panel open state persists per browser; keyboard toggles (mod+B sidebar, mod+J terminal, mod+I inspector, mod+K palette) never animate. Settings live on a deep-linkable /settings route with global sections (Account, Appearance, Models, Machines, Agents, Shortcuts) and per-project sections (Connections, Budgets). Permanent panes meet edge-to-edge and are separated by one-pixel borders rather than floating inside shells. The base rhythm is 4, 8, 12, 16, 24, and 32 pixels. Compact density is the default, while comfortable density increases control height from 32 to 40 pixels and row height from 28 to 36 pixels without changing information architecture. Below 1040 pixels the inspector becomes a modal drawer with focus entry, Escape close, and trigger-focus restoration; below 720 pixels Relay becomes an attention-first supervisory surface rather than stacking every desktop panel. Project, legacy run, and canvas selection are URL-backed so refresh, sharing, and browser history preserve workspace context.

## Elevation & Depth

Permanent application structure is flat and line-led. Warm surface shifts distinguish navigation, work, and raised operation regions; stronger lines identify boundaries that can move or receive focus. Menus, command palettes, dialogs, and other temporary overlays may use one short, neutral shadow so their transient relationship is obvious. Focus rings sit above borders and use the accent color, while active handoff traces use primary. Never use glow, colored shadow, blur haze, glass effects, or elevation as a substitute for hierarchy.

## Shapes

Shape communicates assembly. Structural workspaces, terminal panes, diff panes, trace rails, and full-height navigation remain square so they read as connected parts of one instrument. Inputs and buttons use a 5-pixel radius, operation cards use 7 pixels, and the composer uses 10 pixels because it is the largest continuous interactive control. Three-pixel rounding is reserved for tightly nested states, while the full radius exists only for circular presence indicators and switches. Avoid repeating the same rounded rectangle at every level of the interface.

## Components

Primary buttons represent one clear forward handoff and move to button-primary-hover on hover; secondary actions remain border-led and danger actions are reserved for consequential destructive operations. Inputs and the composer share the same surface and focus language, but the composer keeps model, access, attachment, branch, and send controls in a stable footer rather than becoming a floating hero element. Navigation items preserve position between inactive and active states, using weight, surface contrast, and a short brass contact line rather than motion. Operation-card covers tool calls, approvals, plans, checkpoints, pairing steps, MCP requests, and subagent results; its leading line identifies semantic state and may join the handoff trace when sequence matters. Workspace-pane is the shared foundation for message, terminal, diff, settings, governance, and administration surfaces.

## Do's and Don'ts

Do keep the active task, selected run, run stage, machine, model, permissions, worktree, and pending approvals visible near the work they affect. Do require an explicit impact review before stage, commit, or push, and label previews honestly when remote state cannot be frozen. Do use the handoff trace only when order or propagation clarifies the run. Do make safe defaults, keyboard focus, hover, pressed, disabled, loading, and destructive states unambiguous. Do reuse the same primitives across workbench, orchestration, setup, and administration. Do let terminal output, diffs, logs, and agent events use the full available working area. Do reveal secondary surfaces contextually and preserve the user's density preference.

The production browser currently uses the authenticated legacy Convex transport behind a typed run-data boundary. Kernel projection publication is now authenticated (device-token, owner/machine-scoped) with contiguous-sequence enforcement, exact-duplicate detection, and monotonic snapshot/cursor checks. Owner-scoped `listProjectionRuns`, `getRunSnapshot`, and `listRunEvents` queries exist. The `run-data.ts` boundary exposes `resolveRunData(projectionEnabled)` to switch between legacy and projection reads via `RELAY_VITE_PROJECTION_ENABLED=true`.

Real Codex app-server transport and session adapter are implemented and pinned to **codex-cli 0.144.3** (schemas vendored at `packages/providers/codex-app-server/src/generated/`, 598 TS files). A stdio JSON-RPC 2.0 transport with initialize handshake, bounded queues, and process-lifecycle management lives at `codex-transport.ts`. A `CodexSessionAdapter` normalizes all Codex thread/turn/item/approval/error notifications through the existing `normalizeCodexNotification` table, producing bounded, sanitized canonical events. The kernel daemon (`kernel-daemon.ts`) routes `turn.send` commands through the Codex adapter when `RELAY_CODEX_ENABLED=1` and `codexTransport.enabled` is set, falling back to the catalog LLM provider otherwise.

**Provider projection parity:** All 31 canonical event types are producible and verified. The normalizer covers `thread/created`, `thread/resumed`, `thread/stopped`, `turn/started`, `turn/steered`, `turn/completed`, `turn/failed`, `turn/interrupted`, `agent/text-delta`, `agent/completed`, `activity/started`, `activity/delta`, `activity/completed`, `activity/failed`, `approval/requested`, `approval/resolved`, `usage/recorded`, `error` → `turn.failed`, `thread/closed`, and unknown→diagnostic default. `provider.session.resumed` is now correctly emitted on `thread/resumed`. The daemon kernel emits `run.created`, `run.stopping`, `run.stopped`, `run.failed`, `checkpoint.captured`, `checkpoint.restored`, `checkpoint.compared`, `workspace.diff.updated`, `git.action.updated`, `run.configuration.updated`, `review.comment.created`, `review.comment.resolved`, and `projection.published` directly.

**Acceptance & rehearsal:** `acceptance.e2e.test.ts` (8 tests, all 31 types covered). `backup-rehearsal.test.ts` (3 tests: serialize→crash→restore→continue, empty restore, snapshot field round-trip). `codex-smoke-test.ts` (skipped when `RELAY_CODEX_ENABLED != 1`, runs a real ephemeral thread/turn round-trip when enabled).

**Cutover gates:** `DEFAULT_GATES` now has `kernelReady`, `releaseWindowSatisfied`, `backupRehearsalVerified`, and `acceptanceGatesPassed` all `true`. Only `zeroLegacyActivations` remains `false` (requires operational monitoring). The effective default remains `legacy` until `zeroLegacyActivations` is also satisfied.

Don't add gradients, glows, decorative telemetry, KPI-card grids, or status theatrics. Don't make a message feed the canvas, machines the dominant hierarchy, or terminal/changes/agents/connections an unrelated utility drawer. Don't turn the handoff trace into a looping animation, progress decoration, or false precision. Don't use chat bubbles, oversized welcome panels, ornamental copy, or excessive whitespace. Don't crowd the shell with permanent toolbars, unlabeled icons, or every tool at once. Don't use color alone to convey status, permission, or risk. Don't round structural panes, turn routine actions into pills, or hide agent operations behind friendly but vague abstractions.
