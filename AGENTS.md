# relay

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/` in this repo; there are no external PRs to triage. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), recorded as a `Status:` line in each issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` (domain glossary) and `docs/adr/` (architecture decision records) at the repo root. See `docs/agents/domain.md`.

**Active ADRs:** `0001-adapter-first-local-harness.md`, `0002-local-authority-convex-projections.md`, `0003-canonical-command-event-model.md` — these supersede the v1 "own agent loop" decision.

**Kernel spec:** `.scratch/harness-kernel/PRD.md` — the binding problem/solution framing. Implementation tickets: `tickets.md` (second section).

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
