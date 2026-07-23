# Kernel Approval Suspension Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a kernel tool call with policy `ask` create a durable approval, suspend the active turn without blocking the command poller, and resume the matching tool call after an allow/deny resolution.

**Architecture:** Keep the orchestration reducer as the transition owner. The kernel provider reactor creates the approval and emits `approval.requested`, then returns so `approval.resolve` can be claimed independently. The approval stores private continuation JSON; the resolve reactor validates the matching continuation, executes or refuses the held tool, and the decider emits `approval.resolved` followed by `turn.completed` after the provider effect succeeds.

**Tech Stack:** TypeScript, Bun tests, Convex mutations/queries, `LocalHarnessRuntime`, canonical events, governed tool executor.

### Task 1: Define the RED seams

**Files:**
- Modify: `apps/daemon/src/kernel-daemon.wiring.test.ts`
- Modify: `packages/orchestration/src/decider.test.ts`
- Modify: `convex/approvals.convex.test.ts`

Write tests for non-blocking approval creation, matching approval resolution, terminal turn ordering, and private continuation persistence. Run each focused file and confirm the expected failures.

### Task 2: Add durable approval continuation data

**Files:**
- Modify: `convex/schema.ts`
- Modify: `convex/approvals.ts`
- Modify: `apps/daemon/src/relay-client.ts`
- Modify: `apps/daemon/src/governed-tool-executor.ts`

Add optional continuation JSON and turn identity to approval records. Expose a device-authenticated create/get gateway for the kernel while preserving the polling `requestApproval` API used by legacy workers. Add an explicit approved/denied execution override so a resolved approval cannot prompt again.

### Task 3: Suspend and resume through the kernel reactor

**Files:**
- Modify: `apps/daemon/src/kernel-daemon.ts`
- Modify: `packages/contracts/src/effects.ts`
- Modify: `packages/orchestration/src/decider.ts`
- Modify: `packages/orchestration/src/orchestration-engine.ts`
- Modify: `packages/contracts/src/runtime-schemas.ts` only if the new effect result requires validation changes

On `ask`, create the approval, emit `approval.requested`, and return an explicit pending result without `turn.completed`. Register a real `provider.resolve_approval` reactor that loads and validates the private continuation, executes/refuses the held tool, and emits activity completion. Carry the active turn through the approval effect so the decider emits `approval.resolved` and `turn.completed` in order.

### Task 4: Update the capability boundary and evidence

**Files:**
- Modify: `tickets.md`
- Modify: `docs/operations/kernel-mode-capability-gaps.md`
- Modify: `docs/operations/release-evidence/2026-07-23-cross-tier-recovery-seam.md`

Mark approval suspension/resolution complete only for matching allow/deny tool continuation. Keep provider continuation with tool results, true steering, true interrupt cancellation, and automatic checkpoints open.

### Task 5: Verify, review, and commit

Run focused tests, `bun run typecheck`, `bun run test`, `bun run build`, `bun run security:gate`, `bun run bundle:check`, and `git diff --check`. Review the complete diff and commit the implementation.
