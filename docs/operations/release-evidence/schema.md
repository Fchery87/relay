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

The protected CI jobs run through `scripts/run-protected-evidence.ts`. They
upload `cross-tier-recovery-<run-id>` and `real-codex-harness-<run-id>` JSON
artifacts even when the underlying command fails. Those artifacts prove what
the protected runner observed; they do not change the corresponding release
gate until an operator reviews and records the result.
