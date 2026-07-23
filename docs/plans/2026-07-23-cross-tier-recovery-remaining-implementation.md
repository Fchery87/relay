# Cross-Tier Recovery Seam Remaining Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the remaining in-scope live acceptance gaps for the real cross-tier recovery seam.

**Architecture:** Extend the existing isolated self-hosted Convex fixture with a deterministic lost-response transport seam. Configure the live daemon with a real temporary Git project resolver, then verify explicit checkpoint restore through the canonical command inbox. Exercise the production Convex projection sink against the real backend for exact duplicates, rejected gaps, and atomic failed batches.

**Tech Stack:** Bun tests, TypeScript, Convex HTTP mutations/queries, KernelDaemon, LocalHarnessRuntime, SQLite/WAL, Git worktrees.

### Task 1: Add failing live acceptance coverage

**Files:**
- Modify: `apps/daemon/src/cross-tier-recovery.e2e.test.ts`
- Modify: `scripts/lib/isolated-convex-fixture.ts`

**Steps:**

1. Add a real temporary Git project to the live test setup and pass `resolveProjectRoot` to the daemon.
2. Add tests for checkpoint restore, committed-but-lost command response retry, and real projection duplicate/gap/partial publication.
3. Run `bun test apps/daemon/src/cross-tier-recovery.e2e.test.ts` and confirm the new coverage fails or is not yet type-correct for the missing fixture seam.

### Task 2: Implement the smallest fixture seam

**Files:**
- Modify: `scripts/lib/isolated-convex-fixture.ts`

**Steps:**

1. Add a helper that performs a real Convex call and deliberately drops the successful response from the caller.
2. Keep the helper isolated to tests and preserve the existing authenticated call path.
3. Rerun the focused live test file and confirm the new tests pass.

### Task 3: Update ticket evidence

**Files:**
- Modify: `tickets.md`
- Modify: `docs/operations/release-evidence/2026-07-23-cross-tier-recovery-seam.md`

**Steps:**

1. Mark only the newly proven in-scope acceptance items complete.
2. Record the exact live test command, coverage, and remaining external/provider/capability gaps.

### Task 4: Verify, review, and commit

**Steps:**

1. Run daemon typechecking and the focused live test file.
2. Run the full repository test suite and relevant build/security checks.
3. Review the final diff for correctness and scope.
4. Commit the completed work on the current branch.
