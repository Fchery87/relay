# Walking Skeleton Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a development daemon register a machine and its projects in Convex so the React SPA shows its online/offline state reactively.

**Architecture:** Bun workspaces separate the daemon, web SPA, shared domain contracts, and Convex functions. The daemon sends a typed registration request once and periodic heartbeats thereafter; Convex computes `online` from the heartbeat timestamp, while the web client subscribes to the machines/projects query and renders that derived state.

**Tech Stack:** Bun, TypeScript, Zod, Convex, Vite, React 19, TanStack Router, Vitest.

### Task 1: Scaffold the workspace

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `apps/daemon/package.json`, `apps/web/package.json`, `packages/shared/package.json`, `convex/package.json`
- Create: root and package TypeScript configuration files

**Step 1:** Add workspace scripts for typechecking and tests.

**Step 2:** Install the declared dependencies with Bun.

**Step 3:** Run `bun run typecheck` to verify the empty workspace compiles.

### Task 2: Define and test the heartbeat contract

**Files:**
- Create: `packages/shared/src/machines.ts`
- Create: `packages/shared/src/machines.test.ts`

**Step 1:** Write failing tests that a fresh heartbeat is online and an expired heartbeat is offline.

**Step 2:** Run the test and verify it fails because the module is absent.

**Step 3:** Implement schemas and a pure `machinePresence` helper.

**Step 4:** Re-run the test until it passes.

### Task 3: Persist machines and projects in Convex

**Files:**
- Create: `convex/schema.ts`, `convex/machines.ts`

**Step 1:** Add Convex tables and mutations for register/heartbeat plus a query returning machines with nested projects.

**Step 2:** Typecheck the Convex module.

### Task 4: Run a daemon heartbeat loop

**Files:**
- Create: `apps/daemon/src/config.ts`, `apps/daemon/src/relay-client.ts`, `apps/daemon/src/index.ts`
- Create: `apps/daemon/src/relay-client.test.ts`

**Step 1:** Write a failing test for registering once and sending subsequent heartbeats.

**Step 2:** Implement an injectable daemon client against the Convex HTTP client.

**Step 3:** Run the focused test and then all daemon tests.

### Task 5: Render the reactive browser UI

**Files:**
- Create: `apps/web/src/main.tsx`, `apps/web/src/app.tsx`, `apps/web/src/app.css`, `apps/web/src/lib/convex.ts`

**Step 1:** Implement a TanStack Router root view backed by the Convex query.

**Step 2:** Render machine status and project navigation with loading and empty states.

**Step 3:** Build/typecheck the SPA.

### Task 6: Verify and commit

**Files:** all changed files

**Step 1:** Run `bun run typecheck` and `bun run test`.

**Step 2:** Run `/code-review` against the completed diff and address findings.

**Step 3:** Commit the scoped change with `feat: add Relay walking skeleton`.
