# Pairing schema compatibility evidence — 2026-07-23

## Scope

The local self-hosted backend contained two historical `pairings` documents
created before `deviceNonce` became required. Both were already claimed and
expired. The compatibility change makes schema deployment safe without
allowing a missing-nonce record to authorize a new machine.

## Evidence

- `bunx convex deploy --yes` against `http://127.0.0.1:3210` completed with
  `Schema validation complete` and `Deployed Convex functions`.
- `convex/pairing.convex.test.ts`: 9 tests passed, including the legacy-row
  registration fence and bounded cleanup mutation.
- `bun run test` (current full-suite verification): 341 daemon tests passed,
  16 intentional protected skips, 0 failures; 59 Convex tests passed.
- `cd convex && bun run typecheck`: passed.

The live cleanup mutation was not run in this evidence capture. Deletion of
the historical rows remains an operator-approved follow-up. Invoke the private
internal mutation from an authenticated maintenance function:

```ts
internal.migrations.cleanupLegacyPairings({ limit: 100 })
```

Retain its returned `deleted` count with the next release record.
