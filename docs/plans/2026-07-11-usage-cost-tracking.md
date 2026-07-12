# Usage and Cost Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Record normalized model usage and catalog-derived cost for every turn, aggregate it per thread, and surface totals plus a per-turn breakdown live in the browser.

**Architecture:** Providers emit discriminated text and usage stream events. The daemon normalizes the final usage snapshot, computes cost from the resolved catalog model, and submits one idempotent record per LLM call. A Convex mutation inserts the record and updates denormalized thread totals atomically; a bounded reactive query feeds a focused usage panel.

**Tech Stack:** Bun, TypeScript, Zod, Convex, React, bun:test, Vitest/convex-test.

### Task 1: Shared usage contract and cost calculation

**Files:**
- Create: `packages/shared/src/usage.ts`
- Create: `packages/shared/src/usage.test.ts`
- Modify: `packages/shared/src/index.ts`

1. Write a failing test using worked token counts and catalog prices, including cached input and thinking-token reporting.
2. Run `bun test packages/shared/src/usage.test.ts` and confirm the missing API is the failure.
3. Add the normalized usage schema and `computeUsageCost` implementation.
4. Re-run the focused test and shared typecheck.

### Task 2: Provider usage events and turn recording

**Files:**
- Modify: `apps/daemon/src/model-provider.ts`
- Modify: `apps/daemon/src/model-router.ts`
- Modify: `apps/daemon/src/agent-loop.ts`
- Modify: `apps/daemon/src/relay-client.ts`
- Modify: provider and loop tests under `apps/daemon/src/*.test.ts`

1. Add failing provider tests for OpenAI Responses, OpenAI-compatible completions, and Anthropic usage payloads.
2. Add a failing agent-loop test proving one normalized, costed record is submitted for a completed scripted turn.
3. Introduce discriminated stream events and provider-specific boundary validation.
4. Accumulate the final usage snapshot, compute cost against the selected model, and record it with an idempotency key.
5. Re-run focused daemon tests and typecheck.

### Task 3: Convex persistence and rollups

**Files:**
- Modify: `convex/schema.ts`
- Create: `convex/usage.ts`
- Create: `convex/usage.convex.test.ts`
- Modify: `convex/conversations.ts`

1. Write a failing Convex integration test proving one call record, exact thread rollups, cache rate inputs, and duplicate-call idempotency.
2. Add the usage table, indexes, thread rollup/budget fields, record mutation, and bounded thread query.
3. Include usage cleanup when deleting a thread.
4. Re-run the focused Convex test and typecheck.

### Task 4: Live usage UI

**Files:**
- Create: `apps/web/src/usage-panel.tsx`
- Create: `apps/web/src/usage-panel.test.tsx`
- Modify: `apps/web/src/thread-view.tsx`
- Modify: `apps/web/src/app.css`

1. Write failing render tests for totals, per-turn details, cache hit rate, and budget warning.
2. Implement the compact expandable panel and wire it to the reactive usage query.
3. Re-run focused web tests and typecheck.

### Task 5: Review and finish

1. Run the code-review workflow and address correctness or maintainability findings.
2. Run the full test suite, all typechecks, production build, and `git diff --check`.
3. Verify each ticket requirement against current files and command output.
4. Mark `tickets.md` complete and commit the scoped changes.
