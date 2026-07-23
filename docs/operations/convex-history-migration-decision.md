# Hosted-history migration decision (Decision D2)

**Status:** Decided
**Date:** 2026-07-22

## Decision

**D2-C: Fresh start. No hosted Convex history is migrated.**

## Basis for this decision

Before recording this, the repository and local machine were checked for
evidence of real hosted-Convex usage predating the self-hosted setup:

- `.env.local` retains a commented-out block labeled "Former Convex cloud
  deployment (free tier disabled 2026-07)" with `CONVEX_DEPLOYMENT`,
  `CONVEX_URL`, and `CONVEX_SITE_URL` values — confirming a hosted
  deployment existed, but that its free tier was **disabled** as of
  2026-07, before this decision was recorded. It is not currently
  reachable through this project's normal tooling.
- The project owner confirmed no meaningful use was made of that hosted
  deployment — no accounts, threads, or runs worth preserving.
- No export, dump, or archive of hosted data exists anywhere in this repo
  or its scripts.

Given the hosted deployment is both disabled and, by the owner's own
account, never held data worth carrying forward, migrating it (D2-A) would
add real engineering cost (export/import tooling, ID remapping, dual-write
period, verification) for no data actually worth preserving. Archiving it
read-only (D2-B) is moot for the same reason — there is nothing meaningful
to preserve access to.

## Consequences

- No export/import migration tooling (Milestone 7's D2-A path) needs to be
  built for this project's history.
- Self-hosted Convex is, and remains, a clean slate: new accounts, new
  pairings, new history. This is already true today, so nothing about the
  running system changes as a result of this decision.
- The "Execute the approved hosted-history outcome" ticket in `tickets.md`
  is satisfied for its *decision* item only — the rest of that ticket's
  scope (quiescing hosted writes, verifying counts/checksums during a
  cutover) does not apply because there is no cutover to execute.
- If a genuinely valuable hosted deployment with real user data is created
  in the future, this decision must be revisited before any self-hosted
  migration or cutover work assumes a fresh start again.
