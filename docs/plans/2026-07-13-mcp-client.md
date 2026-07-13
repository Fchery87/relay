# MCP Client Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add governed MCP 2026-07-28 tools over streamable HTTP and stdio, with user-managed server configuration, connection status, and a fixture-backed end-to-end test.

**Architecture:** Convex stores non-secret MCP server configuration and daemon-reported connection state. The daemon owns transport processes and credential resolution, discovers and TTL-caches bounded tool definitions, exposes those tools to model calls, and executes every MCP invocation through the existing governance gateway. A small protocol module validates all untrusted JSON-RPC and JSON Schema inputs at the boundary.

**Tech Stack:** Bun, TypeScript, Zod, Convex, React, JSON-RPC 2.0, MCP 2026-07-28.

### Task 1: Protocol contracts and transports

**Files:**
- Create: `packages/shared/src/mcp.ts`
- Create: `apps/daemon/src/mcp-client.ts`
- Test: `packages/shared/src/mcp.test.ts`
- Test: `apps/daemon/src/mcp-client.test.ts`

1. Write failing tests for bounded tool schemas, stateless request metadata, required HTTP routing headers, stdio framing, discovery, and `ttlMs` tool caching.
2. Run the focused tests and confirm failures are caused by missing MCP behavior.
3. Implement the smallest validated protocol client and both transports.
4. Re-run focused tests until green, then refactor without changing behavior.

### Task 2: Persistence and status reporting

**Files:**
- Modify: `convex/schema.ts`
- Create: `convex/mcp_servers.ts`
- Test: `convex/mcp_servers.convex.test.ts`
- Modify: `apps/daemon/src/relay-client.ts`

1. Write failing Convex tests for CRUD ownership by project/machine, secret-free configuration, and daemon-only status updates.
2. Implement indexed `mcpServers` records and typed daemon gateway methods.
3. Run Convex tests and code generation.

### Task 3: Governance and agent loop integration

**Files:**
- Modify: `apps/daemon/src/tool-executor.ts`
- Modify: `apps/daemon/src/policy.ts`
- Modify: `apps/daemon/src/governed-tool-executor.ts`
- Modify: `apps/daemon/src/model-provider.ts`
- Modify: `apps/daemon/src/model-router.ts`
- Modify: `apps/daemon/src/agent-loop.ts`
- Modify: `apps/daemon/src/index.ts`
- Test: `apps/daemon/src/policy.test.ts`
- Test: `apps/daemon/src/governed-tool-executor.test.ts`
- Test: `apps/daemon/src/agent-loop.test.ts`

1. Write failing tests showing MCP calls receive declared risk tiers, approvals block execution, planning remains read-only, and discovered schemas surface to the model.
2. Extend the discriminated tool-call contract with MCP calls and route execution through the existing chokepoint.
3. Inject the daemon registry into turn processing and verify focused tests.

### Task 4: Server configuration UI

**Files:**
- Create: `apps/web/src/mcp-server-panel.tsx`
- Test: `apps/web/src/mcp-server-panel.test.tsx`
- Modify: `apps/web/src/thread-view.tsx`
- Modify: `apps/web/src/app.css`

1. Write failing component tests for adding HTTP/stdio servers, environment credential references, status display, editing, and removal.
2. Implement a compact settings panel using the Convex server APIs.
3. Run web tests and typechecking.

### Task 5: Fixture end-to-end and verification

**Files:**
- Create: `apps/daemon/src/fixtures/mcp-server.ts`
- Create: `apps/daemon/src/mcp.e2e.test.ts`
- Modify: `tickets.md`

1. Write an end-to-end test that discovers and calls a fixture tool over each transport through governance.
2. Implement any missing integration behavior and run the focused E2E test.
3. Run code generation, all typechecks, the full test suite, and the production build.
4. Review the complete diff, address P0/P1 findings, mark the ticket complete, and commit all ticket files.
