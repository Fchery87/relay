# Performance And Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep long Relay threads responsive, enforce a browser bundle budget, and prove streamed text and command output are visible within 200 ms.

**Architecture:** Render thread messages and activity events through a shared, dependency-free virtual list that mounts only the visible rows plus a small overscan. Extend the daemon execution seams with explicit output callbacks, then use a shared 200 ms flush policy that publishes the first item immediately and coalesces subsequent updates. Measure built JavaScript assets with gzip and fail CI when the documented budget is exceeded.

**Tech Stack:** React 19, TypeScript, Bun tests, Vite, GitHub Actions.

### Task 1: Define Virtualized List Behavior

**Files:**
- Create: `apps/web/src/virtual-list.tsx`
- Create: `apps/web/src/virtual-list.test.tsx`
- Modify: `apps/web/src/thread-messages.tsx`
- Modify: `apps/web/src/thread-messages.test.tsx`

**Step 1:** Write server-rendered tests demonstrating that a large list exposes list semantics and renders only its initial window.

**Step 2:** Implement a fixed-row virtual list with an accessible scroll container, top and bottom spacers, and bounded overscan.

**Step 3:** Render thread messages through the virtual list and verify existing queued and restore behavior still works.

### Task 2: Virtualize Event Activity

**Files:**
- Modify: `apps/web/src/thread-view.tsx`
- Modify: `apps/web/src/thread-view.test.tsx` or create a focused activity-list test

**Step 1:** Write a focused rendering test for an activity event list larger than one viewport.

**Step 2:** Extract the event projection into a typed component and render it through the shared virtual list.

**Step 3:** Verify the screen retains current labels and terminal behavior.

### Task 3: Enforce Stream Flush Latency

**Files:**
- Modify: `apps/daemon/src/tools.ts`
- Modify: `apps/daemon/src/tool-executor.ts`
- Modify: `apps/daemon/src/governed-tool-executor.ts`
- Modify: `apps/daemon/src/command-worker.ts`
- Modify: `apps/daemon/src/agent-loop.ts`
- Modify: corresponding `*.test.ts` files

**Step 1:** Write failing latency tests using delayed scripted token and command streams; assert the first visible token/output chunk is persisted within 200 ms.

**Step 2:** Add an output callback to command execution and propagate it from queued command work to the Convex gateway.

**Step 3:** Extract the bounded flush policy, flush the first item immediately, and use it for model text and command output.

### Task 4: Check Bundle Size In CI

**Files:**
- Create: `scripts/check-bundle-budget.ts`
- Create: `scripts/check-bundle-budget.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Step 1:** Write tests for gzip measurement and budget rejection.

**Step 2:** Implement a deterministic check for every generated JavaScript asset, with a 300 KiB gzip per-asset limit and a 600 KiB gzip total limit.

**Step 3:** Add `bun run bundle:check` after the web build in CI.

### Task 5: Verify And Deliver

**Files:**
- Modify: `tickets.md`

**Step 1:** Run focused tests, typechecks, the production web build, the bundle check, and `bun run test`.

**Step 2:** Review the diff for correctness, accessibility, and accidental credential exposure.

**Step 3:** Mark the ticket complete and commit the scoped changes.
