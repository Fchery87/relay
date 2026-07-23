# Remaining Ticket Closure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete every remaining locally implementable acceptance item across the kernel, provider, operations, security, distribution, and conformance tickets, while leaving only gates that require real credentials, a supervised release window, or irreversible production migration.

**Architecture:** Preserve the canonical orchestration engine as the sole owner of run state. Add missing automation and evidence around the existing seams: pinned Codex schema generation/checking, security and authorization validation, signed release artifacts, operator procedures, and deterministic conformance/crash/load evidence. Do not remove legacy runtime or narrow schemas until the explicit release gates prove it is safe.

**Tech Stack:** Bun, TypeScript, SQLite, Convex, Codex app-server JSON-RPC, GitHub Actions, shell installers, Vitest/Bun test.

### Task 1: Reconcile ticket acceptance with current implementation

**Files:**
- Modify: `.scratch/harness-kernel/issues/remaining-acceptance-criteria.md`
- Modify: `docs/operations/release-evidence/2026-07-23-cross-tier-recovery-seam.md` when evidence changes

Verify each checkbox against code and test evidence before changing it. Keep credentialed provider, supervised rollout, release-window, and irreversible migration items explicitly open.

### Task 2: Close provider automation gaps

**Files:**
- Create: `scripts/generate-codex-app-server-schema.ts`
- Modify: `package.json`
- Test: `scripts/check-codex-app-server-schema.test.ts`

Provide a reproducible generator/checker pair that uses the pinned Codex version, writes into a staging directory, and fails closed when the installed CLI is absent or generated output differs.

### Task 3: Close security and authorization evidence gaps

**Files:**
- Inspect/modify: `convex/*.ts` authorization and audit paths
- Test: `convex/*.convex.test.ts` and `apps/daemon/src/kernel-daemon.wiring.test.ts`
- Modify: `docs/security/threat-model.md` and `docs/security/security-invariants.md` if evidence is missing

Exercise owner/project/device authz, audit correlation, secret custody, and hostile input/sandbox boundaries with an explicit matrix.

### Task 4: Close distribution and operator gaps

**Files:**
- Inspect/modify: `scripts/build-release.ts`, `scripts/install.sh`, `scripts/install.ps1`, `.github/workflows/release.yml`
- Modify: `docs/operations/incident-runbook.md`, `docs/production-deployment.md`
- Test: `scripts/release-targets.test.ts`, installer and release tests

Verify signed/versioned artifact metadata, checksum enforcement, upgrade compatibility, backup/restore, supervisor shutdown, and operator rollback instructions.

### Task 5: Close conformance and evidence automation gaps

**Files:**
- Inspect/modify: `scripts/run-conformance-matrix.ts`, `scripts/run-crash-matrix.ts`, `scripts/production-acceptance.ts`, `docs/operations/slo.md`, `docs/operations/support-matrix.md`
- Test: corresponding script tests and deterministic runtime suites

Ensure the scripts produce machine-readable evidence and fail closed on unsupported or unverified matrix entries; do not claim OS/provider production runs that were not executed.

### Task 6: Final verification and gate audit

Run package typechecks, focused suites, the full test suite, schema/release/conformance checks, and `git diff --check`. Update the acceptance checklist with exact evidence and commit each coherent slice.
