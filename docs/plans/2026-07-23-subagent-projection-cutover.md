# Subagent Projection Cutover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the legacy subagent-tree read from the browser's projection cutover path by deriving the inspector state from canonical activity events.

**Architecture:** The kernel already emits bounded `activity.started`, `activity.delta`, `activity.completed`, and `activity.failed` events for delegated subagents. The browser reduces those events into the existing `SubagentRun` view shape; the legacy Convex query remains available only when the rollback boundary is active.

**Tech Stack:** TypeScript, React, Bun tests, canonical Relay event projections.

### Task 1: Prove the projection reducer

**Files:** `apps/web/src/canonical-runtime.test.ts`, `apps/web/src/canonical-runtime.ts`

- Add a failing test for a started/completed subagent activity lifecycle.
- Implement the reducer with bounded role, task, status, and result fields.
- Verify the focused web test passes.

### Task 2: Wire the browser rollback boundary

**Files:** `apps/web/src/thread-view.tsx`

- Gate `subagents:listTree` behind the legacy boundary.
- Feed the inspector from the canonical activity reducer when projection mode is enabled.
- Verify the web typecheck and canonical runtime tests.

### Task 3: Preserve task context and record evidence

**Files:** `apps/daemon/src/adapters/subagent-adapter.ts`, `docs/operations/release-evidence/2026-07-23-cross-tier-recovery-seam.md`, `docs/operations/kernel-mode-capability-gaps.md`, `tickets.md`

- Include the bounded delegated task in the canonical activity-start payload.
- Document the migrated subagent surface and the remaining plan/MCP/slash-command surfaces.

### Task 4: Verify and commit

- Run focused daemon/web tests, package typechecks, and the full repository suite.
- Commit the verified change with a focused conventional commit.
