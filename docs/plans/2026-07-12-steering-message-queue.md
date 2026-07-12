# Steering and Message Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep mid-run messages visibly queued, inject them at safe tool boundaries, and let an explicit Stop abort model streaming without affecting approvals.

**Architecture:** Convex remains the authoritative queue and stop state. Sending during `running` or `awaiting-approval` inserts a queued message without overwriting thread state; the daemon claims thread-scoped steering messages after each tool call and adds them to the next model prompt. A separate stop flag is polled during model streams, propagated through an `AbortSignal`, and acknowledged into a stopped state while a daemon-side lock prevents concurrent turns.

**Tech Stack:** Bun, TypeScript, Zod, Convex, React, bun:test, Vitest/convex-test.

### Task 1: Convex queue and stop state

**Files:**
- Modify: `convex/schema.ts`
- Modify: `convex/conversations.ts`
- Create: `convex/steering.convex.test.ts`
- Modify: `packages/shared/src/transport.ts`

1. Write a failing Convex integration test proving a mid-run message stays queued and the thread stays running.
2. Add a thread/status-aware send mutation and a bounded, machine-scoped steering claim mutation.
3. Add failing assertions that queued messages do not resolve approvals and that Stop is independent state.
4. Add request, poll, and acknowledge stop functions plus the stopped thread state.
5. Re-run the focused Convex test and typecheck.

### Task 2: Safe daemon turn boundaries

**Files:**
- Modify: `apps/daemon/src/agent-loop.ts`
- Modify: `apps/daemon/src/agent-loop.test.ts`
- Modify: `apps/daemon/src/relay-client.ts`
- Modify: `apps/daemon/src/index.ts`

1. Write a failing long-tool test where a queued message arrives during the tool and appears in the next provider prompt.
2. Claim and append steering messages after each completed tool call.
3. Write failing tests that Stop skips remaining tool calls and aborts an in-flight model stream.
4. Add boundary checks, stream monitoring, stop acknowledgement, and a single-turn daemon lock.
5. Re-run focused daemon tests and typecheck.

### Task 3: Provider cancellation

**Files:**
- Modify: `apps/daemon/src/model-provider.ts`
- Modify: `apps/daemon/src/catalog-model-provider.test.ts`

1. Write a failing provider test proving the supplied abort signal reaches `fetch`.
2. Pass the signal through catalog and scripted providers.
3. Re-run provider tests and daemon typecheck.

### Task 4: Pending and Stop UI

**Files:**
- Create: `apps/web/src/thread-messages.tsx`
- Create: `apps/web/src/thread-messages.test.tsx`
- Modify: `apps/web/src/thread-view.tsx`
- Modify: `apps/web/src/app.css`

1. Write failing render tests for queued message state and running/stopping Stop controls.
2. Render pending state in the timeline and wire the Stop mutation independently of approval controls.
3. Re-run focused web tests and typecheck.

### Task 5: Review and finish

1. Run the two-axis code review and address correctness/spec findings.
2. Run codegen against the configured Convex dev deployment.
3. Run the full test suite, all typechecks, production build, credential scan, and `git diff --check`.
4. Audit every ticket requirement, mark the checklist complete, and commit only scoped files.
