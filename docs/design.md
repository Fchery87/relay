---
version: alpha
name: Relay Workbench
description: A dark, signal-led workbench for directing local coding agents through explicit, trustworthy handoffs.
colors:
  canvas: "#0D100E"
  surface: "#131714"
  surface-raised: "#1A1F1B"
  surface-hover: "#222820"
  border: "#2C332D"
  border-strong: "#424B42"
  on-surface: "#F0F0E8"
  on-surface-muted: "#A8AA9F"
  on-surface-subtle: "#7D8277"
  primary: "#C7A95D"
  on-primary: "#171207"
  accent: "#E1C779"
  on-accent: "#171207"
  success: "#77A681"
  on-success: "#07130B"
  warning: "#C58D58"
  on-warning: "#180D05"
  error: "#C8726B"
  on-error: "#190706"
  info: "#7E9F97"
  on-info: "#071310"
  terminal: "#090C0A"
  terminal-text: "#D7DBD1"
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

# Relay Workbench Design System

## Overview

Relay is a browser control surface for experienced developers who direct local coding agents through long, focused desktop sessions. Its identity is the switchboard: work enters, passes through agents and tools, pauses at explicit review points, and leaves as a verified change. The interface should feel composed, exact, and quietly mechanical rather than futuristic. T3CODE4 remains the structural reference for the three-surface workbench, but Relay's brass handoff trace and mineral graphite palette make the system its own. Relay must never resemble a theatrical AI control room, a consumer chat application, or a decorative terminal theme.

## Colors

The palette takes its temperature from oxidized metal, warm instrument panels, and brass relay contacts. Canvas, surface, and raised surface form a green-warm graphite ladder; bone-white text avoids the brittle contrast of pure white on black. Primary brass marks the current handoff or one forward action, while the lighter accent is reserved for focus and deliberate hover states. Success, warning, error, and info are muted operational signals that must include text or an icon whenever meaning matters. All specified text pairs meet WCAG AA, and subdued text never carries critical instructions by itself.

## Typography

Geist Sans provides a compact, contemporary voice for navigation, messages, forms, and settings, while Geist Mono carries the machine layer: commands, paths, identifiers, durations, token counts, logs, diffs, and code. The 22-to-16-to-13 heading progression creates audible hierarchy without turning an internal tool into a presentation surface. H1 labels the active workspace or thread, H2 divides major surfaces, and H3 names local operations. Caption and mono styles use tabular figures so changing counts and durations remain visually stable. Avoid uppercase tracking, decorative display type, and mixing mono into ordinary prose.

## Layout

Relay uses a persistent left navigation surface, a flexible central run surface, and an optional contextual right surface for terminal, diff, plan, approval, subagent, or configuration work. A thin handoff trace may connect sequential run stages such as user request, agent work, tool execution, review, and delivery; it encodes state propagation and is never ornamental. Permanent panes meet edge-to-edge and are separated by one-pixel borders rather than floating inside shells. The base rhythm is 4, 8, 12, 16, 24, and 32 pixels. Compact density is the default, while comfortable density increases control height from 32 to 40 pixels and row height from 28 to 36 pixels without changing information architecture. Collapse surfaces by task relevance on narrower screens; do not merely stack every desktop panel into a long page.

## Elevation & Depth

Permanent application structure is flat and line-led. Warm surface shifts distinguish navigation, work, and raised operation regions; stronger lines identify boundaries that can move or receive focus. Menus, command palettes, dialogs, and other temporary overlays may use one short, neutral shadow so their transient relationship is obvious. Focus rings sit above borders and use the accent color, while active handoff traces use primary. Never use glow, colored shadow, blur haze, glass effects, or elevation as a substitute for hierarchy.

## Shapes

Shape communicates assembly. Structural workspaces, terminal panes, diff panes, trace rails, and full-height navigation remain square so they read as connected parts of one instrument. Inputs and buttons use a 5-pixel radius, operation cards use 7 pixels, and the composer uses 10 pixels because it is the largest continuous interactive control. Three-pixel rounding is reserved for tightly nested states, while the full radius exists only for circular presence indicators and switches. Avoid repeating the same rounded rectangle at every level of the interface.

## Components

Primary buttons represent one clear forward handoff and move to button-primary-hover on hover; secondary actions remain border-led and danger actions are reserved for consequential destructive operations. Inputs and the composer share the same surface and focus language, but the composer keeps model, access, attachment, branch, and send controls in a stable footer rather than becoming a floating hero element. Navigation items preserve position between inactive and active states, using weight, surface contrast, and a short brass contact line rather than motion. Operation-card covers tool calls, approvals, plans, checkpoints, pairing steps, MCP requests, and subagent results; its leading line identifies semantic state and may join the handoff trace when sequence matters. Workspace-pane is the shared foundation for message, terminal, diff, settings, governance, and administration surfaces.

## Do's and Don'ts

Do keep the active thread, run stage, model, permissions, branch, and pending approvals visible near the work they affect. Do use the handoff trace only when order or propagation clarifies the run. Do make safe defaults, keyboard focus, hover, pressed, disabled, loading, and destructive states unambiguous. Do reuse the same primitives across workbench, orchestration, setup, and administration. Do let terminal output, diffs, logs, and agent events use the full available working area. Do reveal secondary surfaces contextually and preserve the user's density preference.

Don't add gradients, glows, decorative telemetry, KPI-card grids, or status theatrics. Don't turn the handoff trace into a looping animation, progress decoration, or false precision. Don't use chat bubbles, oversized welcome panels, ornamental copy, or excessive whitespace. Don't crowd the shell with permanent toolbars, unlabeled icons, or every tool at once. Don't use color alone to convey status, permission, or risk. Don't round structural panes, turn routine actions into pills, or hide agent operations behind friendly but vague abstractions.
