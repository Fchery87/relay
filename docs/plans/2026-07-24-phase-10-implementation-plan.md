# Phase 10 implementation plan — production evidence, promotion, legacy deletion

**Status:** Ready for execution
**Scope:** Remaining Phase 10 work only
**Primary constraint:** Do not narrow schemas or delete legacy runtime code until release evidence, backup rehearsal, and kernel-default promotion gates are actually satisfied.

## Purpose

Finish the rebuild by turning the remaining release gates into recorded evidence, then use that evidence to safely promote kernel-default and remove legacy execution paths.

This plan is intentionally split into:
- **local prep** (can be done in this repo now),
- **protected/hosted evidence** (requires external runners/credentials), and
- **irreversible cutover** (only after the evidence exists).

## Remaining Phase 10 tasks

### 1) Production evidence
Record the exact evidence needed for final promotion:
- supported OS conformance matrix
- provider conformance matrix
- production acceptance scenario
- protected release evidence bound to the release commit
- release-window verification
- rollback rehearsal proof

### 2) Kernel-default promotion
Use the recorded evidence to prove:
- kernel is the default execution authority
- no unexpected legacy activations occurred in the release window
- no duplicate side-effect evidence exists
- no unresolved projection divergence remains
- backup/restore rehearsal is complete

### 3) Legacy deletion / cleanup
Only after promotion gates pass:
- delete legacy daemon/runtime code
- remove `RELAY_RUNTIME_MODE` gating and kernel-cutover branching
- remove migration-only Convex reads/writes
- narrow widened schemas
- prune stale characterization tests that only guarded deleted behavior

## Execution order

### Work package 10.A — Local prep and guard tightening
**Goal:** make the final irreversible steps fail closed until evidence exists.

#### Tasks
- Audit all remaining legacy references.
- Keep the release-evidence schema strict and explicit.
- Ensure narrowing guards reject missing or incomplete evidence.
- Keep legacy deletion behind a separate, reviewed step.

#### Likely files
- `apps/daemon/src/runtime-mode.ts`
- `apps/daemon/src/kernel-cutover.ts`
- `apps/daemon/src/narrow.ts`
- `convex/narrow.ts`
- `convex/schema_narrow.ts`
- `docs/operations/release-evidence/schema.md`
- `scripts/release-evidence.ts`
- `scripts/record-release-evidence.ts`

#### Verification
- unit tests for guard failure modes
- evidence schema tests
- narrowing guard tests

---

### Work package 10.B — Protected evidence collection
**Goal:** capture the evidence that local tests cannot prove.

#### Tasks
- Run the supported OS conformance matrix.
- Run the provider conformance matrix.
- Run production acceptance on supported OSes.
- Record artifacts for each hosted/protected runner.
- Store the exact release commit and rehearsal hash.

#### Likely files
- `.github/workflows/ci.yml`
- `scripts/run-protected-evidence.ts`
- `scripts/run-conformance-matrix.ts`
- `scripts/production-acceptance.ts`
- `scripts/release-evidence.ts`
- `docs/operations/release-evidence/*.md`

#### Verification
- matrix jobs pass on supported OSes
- artifacts are present and bound to the release commit
- release-evidence record is complete and accepted

---

### Work package 10.C — Kernel-default release-window proof
**Goal:** prove kernel-default operated for at least one release window with zero unexpected legacy activations.

#### Tasks
- Enable kernel-default for the release window.
- Monitor activations and fallback triggers.
- Record zero unexpected legacy activations.
- Capture backup/restore rehearsal result.

#### Likely files
- `apps/daemon/src/index.ts`
- `apps/daemon/src/kernel-cutover.ts`
- `docs/operations/production-readiness-checklist.md`
- `docs/operations/backup-recovery.md`
- `docs/operations/release-evidence/*.md`

#### Verification
- release window log exists
- activation counts remain at zero for unexpected legacy fallback
- backup/restore rehearsal evidence is attached

---

### Work package 10.D — Narrow schemas
**Goal:** remove widened schema surface only after the release evidence proves it is safe.

#### Tasks
- Remove dual-write columns and legacy-only tables if unused.
- Remove migration-only reads/writes.
- Preserve only the canonical data model.
- Keep narrowing atomic and separately reviewed.

#### Likely files
- `convex/schema.ts`
- `convex/schema_narrow.ts`
- `convex/narrow.ts`
- `convex/migrations.ts`
- `packages/local-store/src/database.ts`
- `packages/local-store/src/persistence-codecs.ts`

#### Verification
- narrowing tests pass
- schema validation passes
- live data remains readable after the narrowed migration

---

### Work package 10.E — Remove legacy runtime code
**Goal:** delete the obsolete runtime once the kernel path is proven safe.

#### Tasks
- Delete `apps/daemon/src/agent-loop.ts`.
- Delete legacy workers/pollers.
- Remove `RELAY_RUNTIME_MODE` selection and kernel-cutover gating.
- Remove any code paths that still preserve legacy-only execution.
- Trim characterization tests that only protect deleted behavior.

#### Likely files
- `apps/daemon/src/agent-loop.ts`
- `apps/daemon/src/index.ts`
- `apps/daemon/src/kernel-cutover.ts`
- `apps/daemon/src/runtime-mode.ts`
- `apps/daemon/src/legacy-runtime.characterization.test.ts`
- `apps/daemon/src/*worker*.ts`

#### Verification
- typecheck
- test suite
- grep/rg audit for `RELAY_RUNTIME_MODE` and legacy worker references
- smoke test for kernel-default path

---

### Work package 10.F — Final release evidence
**Goal:** produce the final record that unlocks the irreversible cleanup.

#### Tasks
- Assemble the final release-evidence JSON.
- Include the exact release commit.
- Attach all hosted/provider/OS artifacts.
- Include rehearsal hash and residual risks.
- Persist the validated record to the release-evidence store.

#### Likely files
- `scripts/release-evidence.ts`
- `scripts/record-release-evidence.ts`
- `docs/operations/release-evidence/*.md`
- `convex/narrow.ts`

#### Verification
- `bun run release:evidence` succeeds
- `bun run release:evidence:record` succeeds for the exact commit
- final readiness assertion passes

## Suggested implementation sequence

1. **Tighten guards and keep the release-evidence schema explicit.**
2. **Collect hosted/protected evidence.**
3. **Record release-window and backup/rollback proof.**
4. **Narrow schemas.**
5. **Delete legacy runtime code.**
6. **Record final release evidence and verify the readiness gate.**

## Exit criteria

Phase 10 is complete only when all of the following are true:
- kernel-default is the sole execution authority
- all external evidence is recorded and bound to the release commit
- backup/restore rehearsal is complete
- schemas are narrowed safely
- legacy runtime code is gone
- `RELAY_RUNTIME_MODE` gating is gone
- the final release-evidence record passes validation

## Risks

- **Irreversible cutover too early:** prevent with fail-closed narrowing guards.
- **Hosted matrix mismatch:** require commit-bound artifacts before promotion.
- **Residual legacy references:** keep a grep-based audit before deletion.
- **Release evidence drift:** store the validated record and reject incomplete inputs.
