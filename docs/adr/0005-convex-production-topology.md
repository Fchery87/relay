# ADR 0005: Convex Production Topology (Decision D1)

**Status:** Accepted
**Date:** 2026-07-22

## Context

`docs/plans/2026-07-22-self-hosted-convex-recovery-implementation-plan.md`
names three unresolved production-topology options (D1-A/B/C) as a blocking
decision before any production deployment work, canary rollout, or hosted
Convex data handling proceeds. Relay currently has **no live production
deployment** — the self-hosted Convex instance at `127.0.0.1:3210` is a
single-user local development environment, started manually
(`~/.local/share/convex-selfhost/start-relay-backend.sh`), with no ingress,
TLS termination, or remote access configured. `docs/production-deployment.md`
and the release CI workflows already describe an intended path to Convex
Cloud + Cloudflare Pages, but that path has never been exercised for a real
deployment.

## Decision

**D1-A: hosted production, self-hosted local development — deferred, not yet executed.**

- Self-hosting claims are scoped to local development only. Nothing in this
  repo should describe the current self-hosted instance as production-ready,
  multi-user, or internet-facing.
- When Relay does go to production, the intended path is Convex Cloud (for
  the backend/auth) plus Cloudflare Pages (for the SPA), matching what
  `docs/production-deployment.md` and `.github/workflows/deploy-production.yml`
  already assume — not self-hosted production (D1-B) or per-customer
  self-managed deployment (D1-C).
- This ADR does **not** claim that path is built, tested, or deployed —
  only that it is the chosen target when the project reaches that stage.
  Standing up a real production deployment, wiring GitHub environment
  secrets, and running a first production smoke test remain open work,
  tracked as the "Cut over" and later milestones in the implementation
  plan's `tickets.md` (Self-Hosted Convex Recovery group) — none of which
  this ADR authorizes starting.
- Ingress/TLS/auth ownership, OS support matrix, service supervision, and
  upgrade/failure behavior for a *self-hosted production* topology (D1-B)
  are explicitly **not defined**, because that topology was not chosen.
  If this decision is revisited toward D1-B, those must be written before
  any self-hosted production deployment work begins.

## Consequences

- Production-facing tickets that assume a live production deployment
  (canary rollout across machines, production topology deployment,
  hosted-history cutover) remain blocked on someone actually standing up
  the Convex Cloud + Cloudflare Pages path and are out of scope until that
  happens — they are not "done" by this ADR.
- Operational docs (`docs/operations/self-hosted-convex.md`,
  `docs/operations/support-matrix.md`) continue to describe the self-hosted
  topology strictly as the local-development environment.
- This decision can be revisited; it is recorded here so future work doesn't
  silently assume D1-B (self-hosted production) or invent ingress/TLS
  policy that was never approved.

## Alternatives considered

- **D1-B: self-hosted production.** Would require defining public ingress,
  TLS, process supervision, backup cadence, and incident response for a
  topology this project has no current need to run in production. Rejected
  for now — revisit if self-hosting a multi-user production instance
  becomes a real requirement.
- **D1-C: per-customer/self-managed deployment.** Would require a support
  matrix and a division of operator responsibility this project does not
  need at its current single-user scale. Rejected for now.
