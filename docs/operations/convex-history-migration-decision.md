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

## Fresh-start semantics are already user-visible

No product surface (sign-up flow, onboarding copy, machine pairing UI)
implies continuity from a prior hosted deployment — checked
`apps/web/src/` for any such messaging on 2026-07-23; there is none to
correct. A new account today is, correctly, a genuinely fresh account.

## Immutable pre-cutover backup and rollback point

Recorded 2026-07-23 (self-hosted `pre-cutover-backups/2026-07-23-fresh-start`,
outside the repo per `docs/operations/backup-recovery.md` — backups
containing live credentials are never committed):

- Taken with `scripts/backup-self-hosted-convex.sh`, checksum-verified with
  `scripts/restore-self-hosted-convex.sh --verify-only`, `chmod -R go-rwx`.
- Manifest sha256: `402c7f91606a9019820b20a833cbbf6268e59465e163f34da5783b9704e96361`
- Rollback point: since D2 is fresh-start (no migration), this backup's
  purpose is to preserve current state before any future kernel/browser
  cutover work — not to preserve pre-migration hosted history, since none
  exists.

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
