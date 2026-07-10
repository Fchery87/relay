# First Conversation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A browser prompt creates a persistent thread and receives a batched streamed assistant response from the local daemon using a real or deterministic provider.

**Architecture:** Convex stores projects, threads, messages, and daemon work-queue state. The browser writes user messages and subscribes to the thread; the daemon polls for queued work, runs an injected `ModelProvider`, and patches one assistant message at most every 200 ms. Provider contracts stay in the daemon package so scripted tests and real adapters share the agent loop.

**Tech Stack:** Bun, TypeScript, Convex, React, Zod, `convex-test`, Vitest.

### Task 1: Add shared conversation contracts

**Files:**
- Create: `packages/shared/src/conversations.ts`, `packages/shared/src/conversations.test.ts`

**Step 1:** Write failing tests for a valid queued user message and streamed assistant message state.
**Step 2:** Implement Zod schemas and exported types.
**Step 3:** Run the focused test until green.

### Task 2: Add typed Convex conversation storage

**Files:**
- Modify: `convex/schema.ts`
- Create: `convex/threads.ts`, `convex/messages.ts`
- Test: `convex/conversations.test.ts`

**Step 1:** Write a Convex document-boundary test: user message creates queued work and an assistant message can be patched into a completed response.
**Step 2:** Add `threads` and `messages` tables, indexes, public browser mutations/queries, and daemon queue operations.
**Step 3:** Use generated `query`/`mutation` exports and indexes rather than table scans or filters.

### Task 3: Build the daemon loop and providers

**Files:**
- Create: `apps/daemon/src/model-provider.ts`, `apps/daemon/src/agent-loop.ts`
- Modify: `apps/daemon/src/index.ts`, `apps/daemon/src/relay-client.ts`
- Test: `apps/daemon/src/agent-loop.test.ts`

**Step 1:** Write failing tests for scripted chunks becoming one persisted assistant message with flushes no slower than 200 ms.
**Step 2:** Implement `ModelProvider`, deterministic scripted provider, daemon queue poller, and message batching.
**Step 3:** Add a real provider adapter selected from daemon-only environment configuration.

### Task 4: Add browser conversation UI

**Files:**
- Modify: `apps/web/src/app.tsx`, `apps/web/src/app.css`
- Create: `apps/web/src/thread-view.tsx`, `apps/web/src/thread-view.test.tsx`

**Step 1:** Write a rendering test for persisted history and a composer mutation.
**Step 2:** Render selected project threads, streamed messages, and composer with pending/error states.
**Step 3:** Verify with a browser against the Convex deployment.

### Task 5: Verify and commit

**Step 1:** Run `bun run typecheck`, `bun run test`, and `bun run build`.
**Step 2:** Run the Convex document-boundary end-to-end test and browser streaming check.
**Step 3:** Review, commit, and mark the ticket complete.
