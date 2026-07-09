# Relay v1 — Wayfinder Map

Label: wayfinder:map
**Status: destination reached 2026-07-09 — no open tickets remain.**

## Destination

A finalized, build-ready Relay v1 spec (PRD published to this tracker, `Status: ready-for-agent`) that incorporates the July-2026 standards review — every open architecture decision resolved so the build effort can start with nothing left to decide. The baseline plan being sharpened is `docs/build-plan.md`. **Reached:** the PRD's Amendments section carries all resolutions; the build effort starts fresh from `tickets.md`.

## Notes

- Domain: browser-based agentic coding platform — local Bun/TS daemon (own agent loop, git worktrees, governance) ⇄ Convex backbone ⇄ Vite+React SPA. Codex Desktop is the UX reference. Live preview is permanently excluded.
- Reference material: `docs/build-plan.md` (approved decisions #1–#10 plus resolved decisions #11–#20), `~/.pi` (Thanos — subagent roster, governance chokepoint, models.json), Codex app docs.
- Skills consulted: `/grilling` + `/domain-modeling` for decision tickets, `/research` for AFK research tickets, `/to-spec` for the final ticket.
- Standing preference: extremely lightweight, fast, powerful. When a decision trades power against weight, surface the trade explicitly rather than assuming.

## Decisions so far

- [Context management strategy for the own loop](issues/05-context-management.md) — summarization compaction at 80%→40% with pinned invariants; tool results cap-and-spill to artifacts; append-only, cache-breakpointed request contract.
- [Evaluate Convex first-party components vs hand-rolled tables](issues/01-convex-building-blocks.md) — hand-rolled tables; borrow agent-component schema shapes + streaming-component write patterns; Workpool earmarked for v2 automations.
- [MCP client target: the 2026-07-28 spec](issues/02-mcp-2026-target.md) — target 2026-07-28 exclusively, stateless-first, HTTP+stdio, Tasks extension yes, MCP Apps no, native-app OAuth with daemon-only token custody.
- [Event schema: adopt AG-UI event types or custom?](issues/03-event-schema-agui.md) — custom typed events in the shared zod package, AG-UI-aligned naming/lifecycle where concepts overlap.
- [OS-level exec sandboxing tiers](issues/04-exec-sandboxing.md) — unix-first: landlock/bubblewrap + seatbelt confine exec to worktree+tmp with secrets denied; unsandboxed runs always require approval; Windows chokepoint-only until v1.x.
- [Per-turn checkpointing and rollback](issues/06-checkpoint-rollback.md) — per-mutating-turn commits under `refs/relay/checkpoints/<thread>/<turn>`; restore-not-destroy revert; GC with the thread.
- [Mid-run steering and message-queue semantics](issues/07-steering-queue.md) — queue + turn-boundary inject + explicit Stop; approvals independent of the queue.
- [Usage and cost tracking](issues/08-usage-cost-tracking.md) — per-LLM-call usage records with cache metrics; thread rollups including subagents; soft budget warnings.
- [Default role roster: which Thanos roles ship in Relay v1?](issues/10-default-role-roster.md) — nine seeded roles; scout and the two focused reviewers merged away; designer deferred to v1.x.
- [Review-mode UX: how one-click review surfaces](issues/11-review-mode-ux.md) — reviewer + reviewer-security jury; P0–P3 findings as inline diff comments feeding the agent's next turn.
- [Publish the Relay v1 PRD](issues/09-publish-prd.md) — all resolutions folded into the PRD (Amendments), `docs/build-plan.md`, and `tickets.md`; destination reached.

## Not yet specified

<!-- empty — all fog either graduated and resolved, or moved beyond this map's destination (see Out of scope) -->

## Out of scope

- Live preview — permanently excluded by the founder's decision.
- Cloud sandbox execution — deferred to v2; this map specced the local-daemon architecture only.
- Building the platform itself — execution starts as a fresh effort from `tickets.md`.
- Productization/pricing/multi-tenant billing — beyond the v1 destination.
- UI design language (a `/design-system` effort) and installer signing/notarization details — implementation-time concerns for the build effort, not spec decisions; formerly listed as fog, relocated here when the destination was reached.
- Automation scheduling design — v2; the Convex-components decision already reserved the dispatch seam (Workpool), which is all the v1 spec needed.
