# Relay Switchboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Apply the approved Relay Switchboard design system to the production web client and introduce a distinctive, accessible vector identity.

**Architecture:** Keep Relay's existing Convex data flow and component boundaries intact while replacing the application shell, workbench composition, and styling layer. The Markdown design guide remains canonical; production CSS mirrors its tokens, while small React primitives provide the logo, density preference, handoff trace, and contextual workbench navigation.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Bun test, Convex React, CSS custom properties, inline SVG.

### Task 1: Lock the visual contract with tests

**Files:**
- Create: `apps/web/src/design-system.test.tsx`
- Read: `docs/design.md`
- Test: `apps/web/src/design-system.test.tsx`

**Step 1: Write the failing token-contract test**

Assert that `app.css` exposes the approved canvas, surface, text, brass, semantic, spacing, radius, and density variables from `docs/design.md`.

**Step 2: Write the failing brand-contract test**

Render the planned `RelayBrand` public component and assert that it exposes an accessible Relay label, a vector mark, and the Relay wordmark without raster or gradient assets.

**Step 3: Run the focused test and verify red**

Run: `bun test apps/web/src/design-system.test.tsx`

Expected: FAIL because the production token contract and `RelayBrand` component do not exist yet.

### Task 2: Implement the identity and density primitives

**Files:**
- Create: `apps/web/src/relay-brand.tsx`
- Create: `apps/web/src/density-control.tsx`
- Modify: `apps/web/src/design-system.test.tsx`
- Test: `apps/web/src/design-system.test.tsx`

**Step 1: Implement the vector identity**

Build a compact relay-contact monogram from SVG paths and terminals. Pair it with a text wordmark, use `currentColor`, and keep the component useful at sidebar, authentication, and compact icon sizes.

**Step 2: Implement density preference**

Add a compact/comfortable segmented control that writes `data-density` on the document root and persists the choice in local storage. Keep compact as the safe default and expose pressed state with `aria-pressed`.

**Step 3: Run the focused test and verify green**

Run: `bun test apps/web/src/design-system.test.tsx`

Expected: PASS.

### Task 3: Recompose the application shell

**Files:**
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/machine-sidebar.tsx`
- Modify: `apps/web/src/auth-panel.tsx`
- Modify: `apps/web/src/machine-sidebar.test.tsx`
- Modify: `apps/web/src/auth-panel.test.tsx`

**Step 1: Write failing shell assertions**

Extend the existing public render tests to require the Relay brand, compact/comfortable density controls, clear machine navigation, and consistent authentication identity.

**Step 2: Run the focused shell tests and verify red**

Run: `bun test apps/web/src/machine-sidebar.test.tsx apps/web/src/auth-panel.test.tsx`

Expected: FAIL on the new shell and identity expectations.

**Step 3: Implement the shell**

Use a fixed structural navigation surface, a concise workspace header, explicit machine/project state, and a low-noise sidebar footer. Do not alter authentication, pairing, or Convex behavior.

**Step 4: Run the focused shell tests and verify green**

Run: `bun test apps/web/src/machine-sidebar.test.tsx apps/web/src/auth-panel.test.tsx`

Expected: PASS.

### Task 4: Build the functional workbench hierarchy

**Files:**
- Create: `apps/web/src/handoff-trace.tsx`
- Create: `apps/web/src/workbench-tabs.tsx`
- Create: `apps/web/src/workbench-navigation.test.tsx`
- Modify: `apps/web/src/thread-view.tsx`

**Step 1: Write failing navigation tests**

At the public component seam, assert that the handoff trace names Request, Plan, Tools, Review, and Deliver in order and marks one current stage. Assert tab semantics for Terminal, Changes, Plan, Agents, and Connections, with a single selected surface.

**Step 2: Run the focused test and verify red**

Run: `bun test apps/web/src/workbench-navigation.test.tsx`

Expected: FAIL because the workbench primitives do not exist.

**Step 3: Implement the workbench primitives and composition**

Derive the current handoff stage from thread mode/status and pending review state. Keep approvals and messages in the central run surface; expose terminal, changes, plan, subagents, and MCP connections through an explicit contextual surface rather than a long undifferentiated page.

**Step 4: Run the focused test and verify green**

Run: `bun test apps/web/src/workbench-navigation.test.tsx`

Expected: PASS.

### Task 5: Apply production styling

**Files:**
- Modify: `apps/web/src/app.css`
- Modify: `apps/web/index.html`
- Test: `apps/web/src/design-system.test.tsx`

**Step 1: Mirror canonical tokens**

Replace legacy colors and arbitrary measurements with the documented graphite, bone, brass, semantic, typography, spacing, radius, and density variables.

**Step 2: Style every existing component state**

Apply the border-led depth language to navigation, messages, approvals, terminal, diff, plans, subagents, MCP, authentication, and pairing. Provide hover, active, focus-visible, disabled, error, loading, and destructive states without gradients, glow, glass, or oversized rounding.

**Step 3: Implement responsive behavior**

At desktop widths, preserve left navigation, central run, and contextual utility surfaces. Below the workbench breakpoint, move the utility surface beneath the run; below the mobile breakpoint, hide structural navigation behind a compact summary and keep the active run primary. Respect reduced motion.

**Step 4: Run token and component tests**

Run: `bun test apps/web/src/design-system.test.tsx apps/web/src/machine-sidebar.test.tsx apps/web/src/workbench-navigation.test.tsx`

Expected: PASS.

### Task 6: Verify, review, and commit

**Files:**
- Review: all changed files

**Step 1: Run focused tests and typecheck**

Run: `bun test apps/web/src/design-system.test.tsx apps/web/src/machine-sidebar.test.tsx apps/web/src/auth-panel.test.tsx apps/web/src/workbench-navigation.test.tsx`

Run: `bun run typecheck`

Expected: PASS with no TypeScript errors.

**Step 2: Run the full test suite and production build**

Run: `bun run test`

Run: `bun run build`

Expected: PASS with zero failing tests and a successful Vite build.

**Step 3: Perform the frontend mirror pass**

Render and inspect the authenticated or deterministic workbench at 390px, around each authored breakpoint, 1280px, and 1920px. Verify focus visibility, density switching, no overflow, and that the logo plus handoff trace land in the first screenful.

**Step 4: Run two-axis code review**

Review the diff against repository standards and `docs/design.md`/`docs/design.html`. Fix all critical and important findings, then repeat the relevant verification.

**Step 5: Commit the implementation**

Commit the reviewed implementation to the current branch with an intentional conventional commit message.
