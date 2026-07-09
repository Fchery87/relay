# Relay v1 — Wayfinder Map

Label: wayfinder:map

## Destination

A finalized, build-ready Relay v1 spec (PRD published to this tracker, `Status: ready-for-agent`) that incorporates the July-2026 standards review — every open architecture decision resolved so the build effort can start with nothing left to decide. The baseline plan being sharpened is `docs/build-plan.md`.

## Notes

- Domain: browser-based agentic coding platform — local Bun/TS daemon (own agent loop, git worktrees, governance) ⇄ Convex backbone ⇄ Vite+React SPA. Codex Desktop is the UX reference. Live preview is permanently excluded.
- Reference material: `docs/build-plan.md` (approved decisions #1–#10), `~/.pi` (Thanos — subagent roster, governance chokepoint, models.json), Codex app docs.
- Skills to consult: `/grilling` + `/domain-modeling` for decision tickets, `/research` for AFK research tickets, `/to-spec` for the final ticket.
- Standing preference: extremely lightweight, fast, powerful. When a decision trades power against weight, surface the trade explicitly rather than assuming.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

## Not yet specified

- Review-mode UX — how the reviewer subagents surface as a one-click diff review (Codex review mode / Bugbot equivalent); sharpens after the subagent and event-schema decisions land.
- Default role roster — which of the 13 Thanos roles ship as Relay defaults vs. get pruned; depends on context-management and subagent decisions.
- UI design language — layout, density, theming for the SPA; a `/design-system` effort once the feature surface is settled.
- Installer signing/notarization and auto-update channel details; sharpens when the distribution phase nears.
- Automation scheduling design (v2 feature, but the spec must mark the boundary cleanly — e.g. whether Convex crons reserve schema space now).

## Out of scope

- Live preview — permanently excluded by the founder's decision.
- Cloud sandbox execution — deferred to v2; this map specs the local-daemon architecture only.
- Building the platform itself — execution starts as a fresh effort once the PRD (this map's destination) is published.
- Productization/pricing/multi-tenant billing — beyond the v1 destination.
