# Release evidence schema

`bun run release:evidence -- --input <facts.json> --output <record.json>`
normalizes operator-supplied release facts into a mode-`0600` JSON record. The
input is intentionally explicit: the command never discovers or assumes that
an external provider, hosted OS, canary window, backup rehearsal, or legacy
activation monitor passed.

The record has `schemaVersion: 1` and contains:

- `commit`, `versions`, `topology`, and `migrationState` identifying what was
  exercised;
- `sourceArtifacts` and `testIds` identifying the evidence that was actually
  supplied;
- `rehearsalHash`, the reviewed hash of the backup/rollback rehearsal that is
  required by the Convex narrowing guard;
- `gates`, with all nine required booleans: `kernelReady`, `shadowParity`,
  `canaryRollout`, `supportedOsConformance`, `providerConformance`,
  `productionAcceptance`, `backupRehearsal`, `releaseWindow`, and
  `zeroLegacyActivations`;
- bounded `redactedFailures`, `redactedLogs`, and `residualRisks`; and
- `promotionBlocked`, recomputed from the facts rather than trusted from input.

`assertReleaseEvidenceReady` rejects malformed records, missing facts, false
gates, failures, unredacted recognizable secrets, and oversized diagnostic
arrays. A CLI record with any blocker is still written for diagnosis but exits
with status `78`; only a complete record with every gate true can be accepted
by the readiness assertion.

The schema is a container and validator, not a release waiver. The current
repository still requires real credentialed Codex, hosted macOS/Windows
results, shadow/canary observation, and a supervised kernel-default release
window before the final gates can truthfully be set to `true`.

The protected CI jobs run through `scripts/run-protected-evidence.ts`. Each
artifact includes the runner `platform`, `arch`, and Bun `runtime`, and the
workflow uploads `cross-tier-recovery-<run-id>` plus one
`real-codex-harness-<os>-<run-id>` artifact for each supported hosted OS. The
artifacts are uploaded even when the underlying command fails. They prove what
each protected runner observed; they do not change the corresponding release
gate until an operator reviews the complete matrix and records the result.

## Convex narrowing guard

The final contraction boundary is not a public Convex API. The maintenance
queries in `convex/schema_narrow.ts` and the mutation in `convex/narrow.ts` are
internal-only. A protected release controller must first persist the complete
gate record through `internal.narrow.recordReleaseEvidence`; the narrowing
mutation then compares its supplied rehearsal confirmation with the
server-stored hash and checks all nine gates. Missing evidence, a false gate,
or a hash mismatch fails closed. Even a complete dry run does not perform live
contraction: that irreversible deployment operation remains explicitly
disabled until the separately recorded release-window and rollback procedure
is approved.

Once a complete record exists, an operator can persist only its validated gate
facts into the isolated/self-hosted Convex deployment with:

`CONVEX_SELF_HOSTED_URL=... CONVEX_SELF_HOSTED_ADMIN_KEY=... bun run release:evidence:record -- --input <record.json>`

The admin key is read from the environment and is never placed in the child
process arguments. The command rejects blocked records before contacting
Convex.
