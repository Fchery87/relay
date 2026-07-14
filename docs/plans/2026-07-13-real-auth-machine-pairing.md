# Real Auth and Machine Pairing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Convex Auth email/password sign-in, owner-scoped Relay data, one-time daemon pairing, and browser-managed token revocation.

**Architecture:** Convex Auth's `users` table is the ownership root. Each active machine stores the owning user and only a SHA-256 device-token digest; projects and threads derive their visibility from that machine. `relay connect` creates a short-lived opaque pairing record, waits for an authenticated browser to claim its code, then saves the returned device token in the daemon home. The daemon retains its device-token boundary for machine-owned work, while browser queries and mutations require a signed-in owner.

**Tech Stack:** Bun, TypeScript, Convex Auth, React, Convex, Web Crypto SHA-256, Vitest, Bun test.

### Task 1: Install and initialize Convex Auth

**Files:**
- Modify: `convex/package.json`
- Modify: `apps/web/package.json`
- Create: `convex/auth.ts`
- Create: `convex/auth.config.ts`
- Create: `convex/http.ts`
- Modify: `convex/schema.ts`

1. Add `@convex-dev/auth` and the documented `@auth/core` version to the Convex package, and the auth React package to the web package.
2. Run the official Convex Auth initializer, preserving generated environment secrets outside version control.
3. Add `authTables` to the Convex schema and configure the Password provider with its default minimum requirements.
4. Regenerate Convex API types and typecheck before modifying application behavior.

### Task 2: Add ownership and device-token boundaries

**Files:**
- Create: `convex/auth_helpers.ts`
- Modify: `convex/schema.ts`
- Modify: `convex/machines.ts`
- Create: `convex/pairing.ts`
- Test: `convex/pairing.convex.test.ts`

1. Write failing tests for an unauthenticated browser being rejected, an owner only seeing its machines, pairing-code expiry/one-time use, and revocation rejecting a device heartbeat.
2. Add owner and revocation metadata to machines plus a short-lived pairing table. Retain optional legacy fields only where required to deploy safely against existing dev data.
3. Hash device tokens and pairing codes before persistence. Never return device-token material to browser queries.
4. Implement browser-authenticated pairing claim, daemon polling exchange, owner-scoped machine listing, and revocation.
5. Run the new Convex test file until green.

### Task 3: Scope browser operations by owner and daemon work by machine token

**Files:**
- Modify: `convex/conversations.ts`
- Modify: `convex/commands.ts`
- Modify: `convex/events.ts`
- Modify: `convex/diffs.ts`
- Modify: `convex/diff_comments.ts`
- Modify: `convex/approvals.ts`
- Modify: `convex/audit_log.ts`
- Modify: `convex/git_actions.ts`
- Modify: `convex/checkpoints.ts`
- Modify: `convex/plans.ts`
- Modify: `convex/mcp_servers.ts`
- Modify: `convex/mcp_elicitations.ts`
- Modify: `convex/usage.ts`
- Modify: `convex/subagents.ts`
- Test: targeted existing Convex tests plus owner-isolation coverage

1. Add failing owner-isolation assertions at the project and thread seams.
2. Require authenticated ownership for every browser-visible query and browser-triggered mutation.
3. Require the owning daemon's device token for worker-side mutations, claims, and polling queries that touch a thread or project.
4. Propagate device-token arguments through `apps/daemon/src/relay-client.ts` and its tests.
5. Run focused Convex and daemon tests after each boundary group.

### Task 4: Add daemon pairing command and revocation handling

**Files:**
- Create: `apps/daemon/src/device-credentials.ts`
- Create: `apps/daemon/src/connect.ts`
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/index.ts`
- Modify: `apps/daemon/package.json`
- Test: `apps/daemon/src/device-credentials.test.ts`
- Test: `apps/daemon/src/connect.test.ts`

1. Write failing tests for restrictive credential-file storage and daemon config reading the stored token.
2. Implement `relay connect`, including code display, bounded polling, and token storage in the daemon home.
3. Read the stored token before the development environment fallback; keep no device token in the browser bundle or Convex documents.
4. Stop the daemon after a revoked/invalid device-token error so it is visibly disconnected rather than retrying indefinitely.
5. Run focused daemon tests and typecheck.

### Task 5: Wire sign-in, pairing, and revocation UI

**Files:**
- Create: `apps/web/src/auth-panel.tsx`
- Create: `apps/web/src/auth-panel.test.tsx`
- Create: `apps/web/src/pairing-panel.tsx`
- Create: `apps/web/src/pairing-panel.test.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/machine-sidebar.tsx`
- Modify: `apps/web/src/app.css`

1. Write failing static-render tests for sign-in/sign-up controls, the pairing-code claim form, and machine revocation control.
2. Use `ConvexAuthProvider`, `Authenticated`, `Unauthenticated`, and `AuthLoading` to gate the workspace.
3. Implement separate email/password sign-in and sign-up flows plus sign-out.
4. Show pairing only to authenticated users with no connected machine, and expose revocation through the machine sidebar.
5. Run web tests and typecheck.

### Task 6: Verification and completion

**Files:**
- Modify: `tickets.md`

1. Run `bunx convex codegen`, then all package typechecks.
2. Run focused pairing/auth tests, then `bun run test` and `bun run build`.
3. Sync the development deployment; do not print or commit generated secrets.
4. Review the complete diff for authorization bypasses, secret persistence, and revoked-device behavior.
5. Mark the ticket complete and commit all ticket files.
