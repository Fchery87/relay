# Relay Harness Kernel and Production Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Relay's one-shot, polling-driven agent core with a durable, adapter-first harness kernel, then harden the complete browser-to-daemon workflow for production operation.

**Architecture:** The local daemon remains the execution authority. A WAL-backed local SQLite store owns run, turn, provider-session, workspace, command-receipt, event, and outbox state; one serialized orchestration module decides state transitions and invokes reactors. Convex becomes the authenticated remote-command ingress and browser-facing projection plane. A deep `HarnessRuntime` interface hides orchestration and provider details; Codex app-server over stable stdio JSONL is the first real adapter, with a deterministic fake as the second adapter and the legacy raw-provider path retained only during migration.

**Tech Stack:** Bun 1.3+, TypeScript 5.9, `bun:sqlite`, Zod 4, Codex app-server JSON-RPC over stdio, Convex 1.42+, React 19, Vite 7, Vitest/Bun test, platform-native sandbox adapters, NDJSON/OpenTelemetry-compatible observability.

---

## Source basis

- Relay architecture review performed against the repository on 2026-07-15; baseline verification was green: 184 tests and all workspace typechecks.
- T3 Code reference: commit [`ecb35f75839925dd1ac6f854efeef5c9e291d11b`](https://github.com/pingdotgg/t3code/tree/ecb35f75839925dd1ac6f854efeef5c9e291d11b).
- Codex app-server is the selected first provider integration because the official Codex manual identifies it as the deep-integration surface for authentication, conversation history, approvals, and streamed agent events.
- Use stable app-server stdio transport. Do not build Relay on the experimental app-server WebSocket transport.
- Generate and pin Codex TypeScript/JSON schemas from the exact Codex version installed in CI and release builds.

## Locked architecture decisions

1. **Adapter-first harness.** Reverse the old "own raw agent loop" decision. Codex app-server owns Codex-native session and turn behavior. Relay owns orchestration, remote supervision, governance policy, workspaces, checkpoints, subagents, MCP coordination, synchronization, and product state.
2. **Local execution authority.** Provider sessions, process handles, local command scheduling, event ordering, and retry ownership live in the daemon.
3. **Convex projection plane.** Convex carries authenticated remote intents and curated, resumable browser projections. It does not own provider process state.
4. **One transition owner.** Only the orchestration module changes run state. React, Convex gateway adapters, provider adapters, and workspace adapters emit commands/events; none patch run status independently.
5. **Append-only canonical events.** Every accepted command produces zero or more ordered events in the same local transaction as its receipt and projection updates.
6. **At-least-once transport, exactly-once command effect.** Convex and the local outbox may redeliver. Unique command IDs and receipts make redelivery harmless.
7. **Per-run serialization.** One run processes one state transition at a time. Independent runs may execute concurrently under a configurable global limit.
8. **Sandbox plus approval.** The sandbox technically limits execution; approval policy decides whether Relay may widen those limits. One cannot substitute for the other.
9. **Widen-migrate-narrow.** All live Convex schema changes use additive fields/tables, dual-read or dual-write compatibility, batched migration, verification, then narrowing.
10. **No big-bang rewrite.** The existing path remains behind `RELAY_RUNTIME_MODE=legacy|shadow|kernel` until production acceptance gates pass.

## Non-goals

- Reimplementing Effect or T3 Code's full event-sourcing framework.
- Electron, previews, SSH, Tailscale, WSL backend pools, or native mobile clients.
- Interactive PTY support during the kernel migration.
- Provider-specific UI data leaking into canonical contracts.
- Supporting more than Codex plus the deterministic fake before the provider seam passes its conformance suite.

## Target module layout

```text
apps/
  daemon/                         # composition root and process supervisor only
  web/                            # thin browser rendering surface

packages/
  contracts/                      # run/turn/event/command/provider wire contracts
  harness-runtime/                # deep interface used by daemon and tests
  orchestration/                  # decider, engine, reactors, concurrency control
  local-store/                    # SQLite migrations, events, receipts, snapshots, outbox
  provider-runtime/               # driver/instance/session registry
  providers/
    codex-app-server/             # stable stdio JSON-RPC adapter
  workspace-runtime/              # worktrees, checkpoints, sandboxed commands
  client-runtime/                 # snapshot/resume/cache/command submission
  shared/                         # legacy/shared utilities during migration

convex/
  commands/                       # authenticated remote intent ingress
  projections/                    # browser-facing replicated state
  migrations/                     # online schema/data migrations
  auth/                           # user/device authorization helpers
  machines/                       # pairing, presence, version compatibility
```

Update the root workspace globs to include `packages/providers/*`.

## Canonical lifecycle

```text
Browser mutation
  -> Convex commandInbox(commandId, machineId, runId, payload)
  -> daemon sync adapter receives or retries command
  -> local command_receipts rejects duplicates
  -> orchestration decider validates command against current run state
  -> local transaction appends canonical events + updates projections + receipt + outbox
  -> reactors perform provider/workspace/checkpoint side effects
  -> side-effect results return as new internal commands
  -> projection outbox publishes ordered events/snapshots to Convex
  -> client-runtime applies snapshot then events after sequence
  -> React renders client-runtime state
```

## Required invariants

- Event sequence is strictly increasing per run and never reused.
- `commandId` is globally unique and a completed receipt is immutable.
- A turn has at most one terminal event: completed, failed, or interrupted.
- A provider-native event maps to at most one canonical event identity.
- A projection cursor advances only after the corresponding Convex write succeeds.
- A daemon crash cannot leave a command permanently owned without an expired lease or recoverable receipt.
- A run's worktree, provider instance, effective permission profile, and checkpoint baseline are durable before its first turn starts.
- Browser and Convex input is parsed as untrusted data at the daemon ingress.
- Secrets and raw prompts are excluded from cloud projections and default logs.
- Legacy and kernel paths never execute the same user turn simultaneously.

## Release gates

### Kernel complete

- A real Codex turn can start, stream, request approval, be steered, be interrupted, resume after daemon restart, checkpoint changes, and complete through `HarnessRuntime`.
- Duplicate command delivery produces one effect.
- Projection loss/reconnect resumes from a durable sequence without missing or duplicating visible activity.
- All direct 200 ms claim pollers are gone from the kernel path.

### Operationally reliable

- Kill tests pass at every lifecycle phase.
- Local migrations, outbox replay, provider restart, and worktree reconciliation are automated.
- Sandboxing is enforced on Linux and macOS; Windows behavior is explicit and fail-closed where unavailable.
- Structured traces join browser command, Convex ingress, local command, provider turn, tool activity, and checkpoint.

### Production complete

- Signed/versioned artifacts, controlled upgrades, compatibility checks, migration rollback, backup/recovery, security review, load tests, and an operator runbook are complete.
- The full production acceptance scenario at the end of this plan passes on the supported OS matrix.

## Execution dependency map

```text
Tasks 1-3: decisions + safety rails
    |
Tasks 4-8: contracts and deep interfaces
    |
Tasks 9-13: local durability and orchestration
    +---------------------------+
    |                           |
Tasks 14-17: Codex adapter   Tasks 18-21: workspace/security/history
    |                           |
    +-------------+-------------+
                  |
Tasks 22-27: Convex widen/sync/migrate
                  |
Tasks 28-34: client migration and kernel cutover
                  |
Tasks 35-45: reliability, security, and operations
                  |
Tasks 46-50: performance, conformance, acceptance, narrowing
```

- Tasks 14-17 and 18-21 may run in parallel worktrees after Task 13, but their integration gate is shared.
- Tasks 35-38 and 43-45 may run in parallel after kernel cutover; Tasks 39-42 can begin earlier but cannot certify until sandbox and authorization cutovers are complete.
- Convex Task 25 is a multi-deploy production operation, not merely a code merge. Record dry-run output and migration status in the release evidence.
- Task 50 is irreversible cleanup from the application's perspective. It starts only after at least one release window with kernel default, zero legacy activations, and a verified backup/rollback rehearsal.

---

## Phase 0 — Freeze behavior and record decisions

### Task 1: Record the architecture reversal and migration contract

**Files:**
- Create: `docs/adr/0001-adapter-first-local-harness.md`
- Create: `docs/adr/0002-local-authority-convex-projections.md`
- Create: `docs/adr/0003-canonical-command-event-model.md`
- Modify: `.scratch/relay-v1/PRD.md`
- Test: `apps/daemon/src/architecture-contract.test.ts`

**Step 1: Write the failing architecture contract test**

Assert that the root workspace declares the planned package paths and that the PRD no longer describes the raw provider loop as Relay's permanent execution architecture.

**Step 2: Run the test and verify red**

Run: `bun test apps/daemon/src/architecture-contract.test.ts`

Expected: FAIL because the ADRs and package declarations do not exist.

**Step 3: Write the ADRs**

Each ADR must include context, decision, rejected alternatives, migration compatibility, rollback, and consequences. Explicitly supersede the old own-loop decision while preserving `raw-llm` as a temporary adapter and optional text-generation module.

**Step 4: Update the PRD**

Add an amendment linking the ADRs. Do not rewrite historical decisions silently.

**Step 5: Run the focused test and documentation link check**

Run: `bun test apps/daemon/src/architecture-contract.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add docs/adr .scratch/relay-v1/PRD.md apps/daemon/src/architecture-contract.test.ts
git commit -m "docs: adopt adapter-first harness architecture"
```

### Task 2: Add characterization tests for the legacy vertical slice

**Files:**
- Create: `apps/daemon/src/legacy-runtime.characterization.test.ts`
- Modify: `apps/daemon/src/agent-loop.test.ts`
- Modify: `apps/daemon/src/steering-convex.e2e.test.ts`
- Modify: `apps/daemon/src/checkpoint-convex.e2e.test.ts`

**Step 1: Add black-box fixtures**

Capture existing observable behavior for prompt claiming, first visible text, steering, stop, approval refusal, diff snapshot, checkpoint creation, usage recording, and final thread state. Assert only documents/files visible across the current external seams.

**Step 2: Add failure-state characterization**

Demonstrate the current stranded-running behavior when the provider throws after message claim. Mark this test `test.todo` with the intended recoverable result; it becomes green in Phase 2.

**Step 3: Run focused tests**

Run: `bun test apps/daemon/src/legacy-runtime.characterization.test.ts apps/daemon/src/steering-convex.e2e.test.ts apps/daemon/src/checkpoint-convex.e2e.test.ts`

Expected: PASS except the explicitly recorded todo.

**Step 4: Commit**

```bash
git add apps/daemon/src
git commit -m "test: characterize legacy harness behavior"
```

### Task 3: Add runtime-mode flags and a kill switch

**Files:**
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/config.test.ts`
- Create: `apps/daemon/src/runtime-mode.ts`
- Test: `apps/daemon/src/runtime-mode.test.ts`

**Step 1: Write failing configuration tests**

Cover `legacy`, `shadow`, and `kernel`; default to `legacy` until Task 25. Reject unknown values. Add `RELAY_KERNEL_MAX_CONCURRENT_RUNS` with a safe positive-integer validator.

**Step 2: Run and verify red**

Run: `bun test apps/daemon/src/config.test.ts apps/daemon/src/runtime-mode.test.ts`

Expected: FAIL on missing runtime mode.

**Step 3: Implement configuration parsing**

Do not branch throughout the codebase. Return one discriminated `RuntimeMode` value and select the runtime once in the daemon composition root.

**Step 4: Run and verify green**

Run: `bun test apps/daemon/src/config.test.ts apps/daemon/src/runtime-mode.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/daemon/src/config.ts apps/daemon/src/config.test.ts apps/daemon/src/runtime-mode.ts apps/daemon/src/runtime-mode.test.ts
git commit -m "feat: add harness runtime migration modes"
```

---

## Phase 1 — Canonical contracts and deep interfaces

### Task 4: Scaffold the new workspace packages

**Files:**
- Modify: `package.json`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/harness-runtime/package.json`
- Create: `packages/harness-runtime/tsconfig.json`
- Create: `packages/harness-runtime/src/index.ts`
- Create: `packages/orchestration/package.json`
- Create: `packages/orchestration/tsconfig.json`
- Create: `packages/orchestration/src/index.ts`
- Create: `packages/local-store/package.json`
- Create: `packages/local-store/tsconfig.json`
- Create: `packages/local-store/src/index.ts`
- Create: `packages/provider-runtime/package.json`
- Create: `packages/provider-runtime/tsconfig.json`
- Create: `packages/provider-runtime/src/index.ts`
- Create: `packages/workspace-runtime/package.json`
- Create: `packages/workspace-runtime/tsconfig.json`
- Create: `packages/workspace-runtime/src/index.ts`
- Create: `packages/client-runtime/package.json`
- Create: `packages/client-runtime/tsconfig.json`
- Create: `packages/client-runtime/src/index.ts`

**Step 1: Write a workspace smoke test**

Create `scripts/check-harness-packages.test.ts` and assert every new package has a unique name, explicit exports, `typecheck`, and `test` scripts.

**Step 2: Run and verify red**

Run: `bun test scripts/check-harness-packages.test.ts`

Expected: FAIL because packages are absent.

**Step 3: Add minimal package manifests and exports**

Use `@relay/contracts`, `@relay/harness-runtime`, `@relay/orchestration`, `@relay/local-store`, `@relay/provider-runtime`, `@relay/workspace-runtime`, and `@relay/client-runtime`.

**Step 4: Verify workspace discovery**

Run: `bun install && bun run typecheck`

Expected: all packages discovered and typechecking.

**Step 5: Commit**

```bash
git add package.json bun.lock packages scripts/check-harness-packages.test.ts
git commit -m "chore: scaffold harness kernel packages"
```

### Task 5: Define branded identifiers and the canonical event envelope

**Files:**
- Create: `packages/contracts/src/ids.ts`
- Create: `packages/contracts/src/events.ts`
- Create: `packages/contracts/src/events.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Step 1: Write failing schema tests**

Cover `EnvironmentId`, `ProjectId`, `RunId`, `TurnId`, `ActivityId`, `ApprovalId`, `CheckpointId`, `ProviderInstanceId`, `CommandId`, `EventId`, `CorrelationId`, and `CausationId`. Reject blank or oversized identifiers.

**Step 2: Define the envelope**

Use this stable shape:

```ts
type EventEnvelope<TType extends string, TPayload> = {
  eventId: EventId;
  sequence: number;
  streamVersion: number;
  type: TType;
  runId: RunId;
  turnId?: TurnId;
  providerInstanceId?: ProviderInstanceId;
  correlationId: CorrelationId;
  causationId?: CausationId;
  occurredAt: number;
  payload: TPayload;
};
```

`sequence` is assigned by storage; `streamVersion` is the optimistic version within one run stream.

**Step 3: Add the discriminated event union**

Start with:

```text
run.created, run.started, run.stopping, run.stopped, run.failed
provider.session.started, provider.session.resumed, provider.session.stopped
turn.started, turn.steered, turn.completed, turn.failed, turn.interrupted
assistant.delta, assistant.completed
activity.started, activity.delta, activity.completed, activity.failed
approval.requested, approval.resolved
usage.recorded
checkpoint.captured, checkpoint.restored
projection.published
```

Do not encode provider-native notification names as canonical types.

**Step 4: Run tests**

Run: `bun test packages/contracts/src/events.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat: define canonical harness events"
```

### Task 6: Define commands and the run state machine

**Files:**
- Create: `packages/contracts/src/commands.ts`
- Create: `packages/contracts/src/state.ts`
- Create: `packages/contracts/src/state.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Step 1: Write failing transition tests**

Cover allowed and rejected transitions for `created`, `ready`, `running`, `awaiting_approval`, `stopping`, `stopped`, `completed`, and `failed`.

**Step 2: Define the command envelope**

```ts
type CommandEnvelope<TType extends string, TPayload> = {
  commandId: CommandId;
  type: TType;
  runId: RunId;
  expectedStreamVersion?: number;
  correlationId: CorrelationId;
  causationId?: CausationId;
  actor: { kind: "user" | "device" | "provider" | "system"; id: string };
  issuedAt: number;
  payload: TPayload;
};
```

Define external commands for create/resume/send/steer/interrupt/approval/stop/restore and internal commands for provider events, workspace results, checkpoint results, and projection acknowledgements.

**Step 3: Implement a pure reducer**

`reduceRun(state, event)` returns the next immutable state. It performs no I/O and is the only function allowed to define run status semantics.

**Step 4: Run tests**

Run: `bun test packages/contracts/src/state.test.ts`

Expected: PASS with exhaustive switch checks.

**Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat: define harness commands and run state"
```

### Task 7: Define the deep HarnessRuntime interface

**Files:**
- Create: `packages/harness-runtime/src/harness-runtime.ts`
- Create: `packages/harness-runtime/src/harness-runtime.contract.test.ts`
- Create: `packages/harness-runtime/src/fake-harness-runtime.ts`
- Modify: `packages/harness-runtime/src/index.ts`

**Step 1: Write the interface contract suite**

The same suite must run against the deterministic fake immediately and the Codex adapter in Phase 3.

**Step 2: Define the interface**

```ts
export interface HarnessRuntime {
  createRun(input: CreateRunInput): Promise<RunSnapshot>;
  resumeRun(input: ResumeRunInput): Promise<RunSnapshot>;
  sendTurn(input: SendTurnInput): Promise<TurnReceipt>;
  steerTurn(input: SteerTurnInput): Promise<void>;
  interruptTurn(input: InterruptTurnInput): Promise<void>;
  resolveApproval(input: ResolveApprovalInput): Promise<void>;
  stopRun(input: StopRunInput): Promise<void>;
  snapshot(input: SnapshotInput): Promise<RunSnapshot>;
  observe(input: ObserveInput): AsyncIterable<EventEnvelope<CanonicalEventType, unknown>>;
}
```

Keep workspace, provider, store, and Convex adapters out of this external interface.

**Step 3: Implement the deterministic fake**

The fake accepts scripted canonical events, supports controlled blocking, exposes `drain()`, and can simulate duplicate delivery, provider failure, approval waits, and restart.

**Step 4: Run the contract suite**

Run: `bun test packages/harness-runtime/src/harness-runtime.contract.test.ts`

Expected: PASS for the fake.

**Step 5: Commit**

```bash
git add packages/harness-runtime
git commit -m "feat: add deep harness runtime interface"
```

### Task 8: Define provider driver, instance, and session adapter seams

**Files:**
- Create: `packages/contracts/src/provider.ts`
- Create: `packages/provider-runtime/src/provider-driver.ts`
- Create: `packages/provider-runtime/src/provider-instance-registry.ts`
- Create: `packages/provider-runtime/src/provider-session-adapter.ts`
- Create: `packages/provider-runtime/src/provider-runtime.contract.test.ts`
- Create: `packages/provider-runtime/src/fake-provider.ts`
- Modify: `packages/provider-runtime/src/index.ts`

**Step 1: Write the provider conformance suite**

Require availability discovery, start/resume, send, steer, interrupt, approval resolution, stop, normalized events, and process-loss behavior.

**Step 2: Implement the interfaces**

`ProviderDriver` validates provider-instance configuration and creates scoped `ProviderSessionAdapter` instances. `ProviderInstanceRegistry` owns configured instances and never reads environment variables from call sites.

**Step 3: Implement the fake provider**

Give the fake a native-event input and canonical-event output so event normalization is tested at the seam.

**Step 4: Run tests**

Run: `bun test packages/provider-runtime/src/provider-runtime.contract.test.ts`

Expected: PASS for the fake adapter.

**Step 5: Commit**

```bash
git add packages/contracts packages/provider-runtime
git commit -m "feat: add provider runtime seams"
```

---

## Phase 2 — Local durability and one orchestration owner

### Task 9: Build the SQLite migration runner

**Files:**
- Create: `packages/local-store/src/database.ts`
- Create: `packages/local-store/src/migrations.ts`
- Create: `packages/local-store/src/migrations/0001-kernel.ts`
- Create: `packages/local-store/src/migrations.test.ts`
- Modify: `packages/local-store/src/index.ts`

**Step 1: Write failing migration tests**

Test a blank database, repeated startup, interrupted migration, unknown future schema version, and WAL mode. Use temporary databases, not mocks.

**Step 2: Create the initial schema**

Tables:

```text
schema_migrations
run_events
run_snapshots
command_receipts
projection_outbox
provider_sessions
workspaces
leases
```

Required constraints: unique `event_id`, unique `command_id`, unique `(run_id, stream_version)`, indexed `(run_id, sequence)`, indexed unpublished outbox rows, and foreign-key checks enabled.

**Step 3: Implement transactional migrations**

Embed migration SQL/operations in TypeScript so compiled daemon binaries do not depend on loose migration files.

**Step 4: Run tests**

Run: `bun test packages/local-store/src/migrations.test.ts`

Expected: PASS and `PRAGMA journal_mode` reports `wal` for file databases.

**Step 5: Commit**

```bash
git add packages/local-store
git commit -m "feat: add durable local harness store"
```

### Task 10: Implement atomic events, snapshots, receipts, and outbox

**Files:**
- Create: `packages/local-store/src/event-store.ts`
- Create: `packages/local-store/src/command-receipts.ts`
- Create: `packages/local-store/src/outbox.ts`
- Create: `packages/local-store/src/event-store.integration.test.ts`
- Modify: `packages/local-store/src/index.ts`

**Step 1: Write transactional integration tests**

Prove that accepted command receipt, events, reduced snapshot, and outbox rows commit together; injected failure rolls all four back.

**Step 2: Implement optimistic append**

Reject stale `expectedStreamVersion` values with a typed conflict result. Assign sequence and stream version inside the transaction.

**Step 3: Implement idempotent receipt lookup**

If `commandId` already completed, return its stored result without re-running the decider or reactors.

**Step 4: Implement outbox claiming**

Claim bounded batches with a lease, publish, acknowledge, and retry with exponential backoff plus jitter. Never delete acknowledged rows until retention cleanup.

**Step 5: Run tests**

Run: `bun test packages/local-store/src/event-store.integration.test.ts`

Expected: PASS including duplicate and rollback cases.

**Step 6: Commit**

```bash
git add packages/local-store
git commit -m "feat: persist events receipts and projection outbox"
```

### Task 11: Implement the pure decider and orchestration engine

**Files:**
- Create: `packages/orchestration/src/decider.ts`
- Create: `packages/orchestration/src/decider.test.ts`
- Create: `packages/orchestration/src/orchestration-engine.ts`
- Create: `packages/orchestration/src/run-queue.ts`
- Create: `packages/orchestration/src/orchestration-engine.integration.test.ts`
- Modify: `packages/orchestration/src/index.ts`

**Step 1: Write the decider tests**

For every command and run state, assert emitted event intent or a typed rejection. Include duplicate, stale version, approval mismatch, wrong active turn, double terminal event, and stop-during-approval cases.

**Step 2: Implement the pure decider**

The decider accepts current `RunSnapshot` plus one parsed command and returns `{ events, effects }` without I/O.

**Step 3: Write engine integration tests**

Submit concurrent commands for one run and prove serialization; submit commands for two runs and prove bounded parallelism. Verify duplicate command IDs return the original receipt.

**Step 4: Implement per-run queues and global concurrency control**

Expose `submit(command)`, `drain(runId?)`, and `shutdown({ deadlineMs })`. A queue entry owns no durable work until the command transaction begins.

**Step 5: Run tests**

Run: `bun test packages/orchestration/src/decider.test.ts packages/orchestration/src/orchestration-engine.integration.test.ts`

Expected: PASS without timing sleeps; tests synchronize through receipts and `drain()`.

**Step 6: Commit**

```bash
git add packages/orchestration
git commit -m "feat: add serialized orchestration engine"
```

### Task 12: Add reactors and explicit effect completion commands

**Files:**
- Create: `packages/orchestration/src/reactors/provider-reactor.ts`
- Create: `packages/orchestration/src/reactors/workspace-reactor.ts`
- Create: `packages/orchestration/src/reactors/checkpoint-reactor.ts`
- Create: `packages/orchestration/src/reactors/projection-reactor.ts`
- Create: `packages/orchestration/src/reactors/reactors.integration.test.ts`

**Step 1: Write failure and retry tests**

Provider start failure, workspace creation failure, checkpoint failure, and projection failure must return internal commands; reactors must not patch state directly.

**Step 2: Implement effect dispatch**

Each reactor consumes committed effect intents and submits a new internal command with the original correlation ID and causation set to the triggering event ID.

**Step 3: Implement bounded retry policy**

Classify failures as retryable, terminal, or approval-required. Persist retry count and next attempt time; do not hold a JavaScript timer as the only source of retry state.

**Step 4: Run tests**

Run: `bun test packages/orchestration/src/reactors/reactors.integration.test.ts`

Expected: PASS including daemon restart between intent and effect completion.

**Step 5: Commit**

```bash
git add packages/orchestration/src/reactors
git commit -m "feat: add durable orchestration reactors"
```

### Task 13: Compose the kernel HarnessRuntime

**Files:**
- Create: `packages/harness-runtime/src/local-harness-runtime.ts`
- Create: `packages/harness-runtime/src/local-harness-runtime.integration.test.ts`
- Modify: `packages/harness-runtime/src/index.ts`

**Step 1: Run the existing HarnessRuntime contract against an empty implementation**

Expected: FAIL for all lifecycle methods.

**Step 2: Implement the runtime as a thin interface over the deep orchestration module**

Map public calls to commands, wait for durable receipts, return snapshots/turn receipts, and stream committed canonical events after a requested sequence.

**Step 3: Add restart tests**

Create a run, close the runtime, reopen from the same SQLite file, resume observation from the last sequence, and finish the turn.

**Step 4: Run tests**

Run: `bun test packages/harness-runtime/src/harness-runtime.contract.test.ts packages/harness-runtime/src/local-harness-runtime.integration.test.ts`

Expected: contract suite passes for both deterministic fake and local implementation using the fake provider.

**Step 5: Turn the legacy stranded-run todo green**

Update the characterization expectation for kernel mode: provider failure produces `turn.failed` and a recoverable run state.

**Step 6: Commit**

```bash
git add packages/harness-runtime apps/daemon/src/legacy-runtime.characterization.test.ts
git commit -m "feat: compose durable local harness runtime"
```

---

## Phase 3 — Codex app-server provider adapter

### Task 14: Add pinned Codex schema generation

**Files:**
- Modify: `package.json`
- Create: `scripts/generate-codex-app-server-schema.ts`
- Create: `scripts/check-codex-app-server-schema.ts`
- Create: `scripts/check-codex-app-server-schema.test.ts`
- Create: `packages/providers/codex-app-server/package.json`
- Create: `packages/providers/codex-app-server/tsconfig.json`
- Create: `packages/providers/codex-app-server/src/generated/.gitkeep`
- Create: `packages/providers/codex-app-server/src/index.ts`

**Step 1: Write the schema-drift test**

Fail when generated artifacts are missing, generated by a different Codex version, or differ from a fresh generation in CI.

**Step 2: Implement the generator**

Run:

```bash
codex app-server generate-ts --out packages/providers/codex-app-server/src/generated
codex app-server generate-json-schema --out packages/providers/codex-app-server/src/generated/json-schema
```

Record `codex --version` in `generated/version.json`. Reject uncommitted schema drift.

**Step 3: Add workspace scripts**

Add `codex:schema:generate` and `codex:schema:check`. CI must run the check only where the pinned Codex binary is installed.

**Step 4: Generate and verify**

Run: `bun run codex:schema:generate && bun test scripts/check-codex-app-server-schema.test.ts`

Expected: PASS and generated files are committed.

**Step 5: Commit**

```bash
git add package.json bun.lock scripts packages/providers/codex-app-server
git commit -m "feat: pin Codex app-server schemas"
```

### Task 15: Implement supervised stdio JSON-RPC transport

**Files:**
- Create: `packages/providers/codex-app-server/src/stdio-transport.ts`
- Create: `packages/providers/codex-app-server/src/json-rpc-peer.ts`
- Create: `packages/providers/codex-app-server/src/process-supervisor.ts`
- Create: `packages/providers/codex-app-server/src/stdio-transport.integration.test.ts`

**Step 1: Build a fixture app-server process**

The fixture reads JSONL, enforces initialize/initialized ordering, emits notifications, delays responses, exits unexpectedly, writes malformed JSON, and floods output within configured bounds.

**Step 2: Write failing transport tests**

Cover request correlation, notification fan-out, timeout, abort, malformed input, stderr capture, process exit, bounded queues, graceful shutdown, and secret-free command arguments.

**Step 3: Implement transport**

Spawn `codex app-server --listen stdio://`. Send one initialize request followed by `initialized`. Keep bearer tokens and secrets out of argv. Reject requests before ready.

**Step 4: Add overload and restart behavior**

Bound pending requests and notification buffering. On process exit, fail in-flight requests with a typed `ProviderProcessLost` error and let orchestration decide whether to resume.

**Step 5: Run tests**

Run: `bun test packages/providers/codex-app-server/src/stdio-transport.integration.test.ts`

Expected: PASS without connecting to OpenAI.

**Step 6: Commit**

```bash
git add packages/providers/codex-app-server
git commit -m "feat: supervise Codex app-server transport"
```

### Task 16: Normalize Codex threads, turns, items, and approvals

**Files:**
- Create: `packages/providers/codex-app-server/src/codex-driver.ts`
- Create: `packages/providers/codex-app-server/src/codex-session-adapter.ts`
- Create: `packages/providers/codex-app-server/src/normalize-event.ts`
- Create: `packages/providers/codex-app-server/src/normalize-event.test.ts`
- Create: `packages/providers/codex-app-server/src/codex-session-adapter.integration.test.ts`
- Create: `packages/provider-runtime/src/relay-tool-bridge.ts`
- Create: `packages/provider-runtime/src/relay-tool-bridge.test.ts`

**Step 1: Write table-driven event normalization tests**

Map generated Codex notifications for turn start/completion, item start/completion, agent-message deltas, command/file/tool activity, approval requests, errors, and usage into canonical events. Unknown notifications become bounded diagnostic records, not crashes.

**Step 2: Implement the driver and instance configuration**

Validate executable path, config home, environment allowlist, default model, and supported sandbox/approval modes. Availability reports version and schema compatibility.

**Step 3: Implement lifecycle methods**

Map `startSession` to `thread/start`, `resumeSession` to `thread/resume`, send to `turn/start`, steer to `turn/steer`, interrupt to `turn/interrupt`, and approval resolution to the generated matching method. Persist Codex thread ID before acknowledging session start.

**Step 4: Bridge Relay-owned tools and MCP configuration**

Do not assume Codex has Relay's `task` tool. Expose Relay delegation through a provider-supported dynamic-tool or daemon-local stdio MCP adapter selected from the generated Codex schema. The bridge submits an internal orchestration command with run/turn/correlation identity, enforces the persisted capability ceiling again, waits on a durable receipt, and returns the typed subagent result. Project-enabled external MCP servers are supplied through the same provider-instance configuration; their approval and elicitation requests normalize into Relay approval/input events. Add negative tests for forged run IDs, capability escalation, duplicate calls, stale turns, oversized results, and provider restart while waiting.

**Step 5: Run the provider conformance suite**

Run: `bun test packages/provider-runtime/src/provider-runtime.contract.test.ts packages/provider-runtime/src/relay-tool-bridge.test.ts packages/providers/codex-app-server/src/normalize-event.test.ts packages/providers/codex-app-server/src/codex-session-adapter.integration.test.ts`

Expected: deterministic fixture adapter passes the same lifecycle contract as the fake.

**Step 6: Commit**

```bash
git add packages/provider-runtime packages/providers/codex-app-server
git commit -m "feat: add Codex app-server provider adapter"
```

### Task 17: Verify a real local Codex vertical slice

**Files:**
- Create: `apps/daemon/src/codex-harness.e2e.test.ts`
- Create: `scripts/smoke-codex-harness.ts`
- Modify: `package.json`

**Step 1: Add an opt-in real-provider test**

Skip unless `RELAY_E2E_CODEX=1`. Create a temporary Git repository and daemon home; start a run, ask Codex to read and edit a fixture, observe canonical activity, interrupt a second turn, resume the thread, and stop cleanly.

**Step 2: Add assertions at the HarnessRuntime interface**

Do not assert Codex-native notification shapes. Assert canonical events, file effects, durable provider session ID, checkpoint, and terminal state.

**Step 3: Run the fixture test in ordinary CI**

Run: `bun test apps/daemon/src/codex-harness.e2e.test.ts`

Expected: SKIP without opt-in.

**Step 4: Run the real smoke test in protected CI/nightly**

Run: `RELAY_E2E_CODEX=1 bun run scripts/smoke-codex-harness.ts`

Expected: PASS with redacted logs.

**Step 5: Commit**

```bash
git add apps/daemon/src/codex-harness.e2e.test.ts scripts/smoke-codex-harness.ts package.json
git commit -m "test: cover real Codex harness lifecycle"
```

---

## Phase 4 — Workspace authority, sandboxing, context, and checkpoints

### Task 18: Move worktree identity into durable run state

**Files:**
- Create: `packages/contracts/src/workspace.ts`
- Create: `packages/workspace-runtime/src/workspace-manager.ts`
- Create: `packages/workspace-runtime/src/workspace-reconciler.ts`
- Create: `packages/workspace-runtime/src/workspace-manager.integration.test.ts`
- Modify: `apps/daemon/src/worktrees.ts`

**Step 1: Write reconciliation tests**

Cover create, reopen after restart, missing worktree, moved repository, stale local record, nested writer worktree, cleanup failure, and active-run protection.

**Step 2: Implement durable workspace records**

Persist repo path, worktree path, base commit, current checkpoint, permission profile, created time, cleanup status, and owning run. Stop treating `worktrees.json` as authoritative.

**Step 3: Add startup reconciliation**

Reconcile SQLite records with `git worktree list --porcelain`; repair safe discrepancies and emit explicit failures for unsafe ones.

**Step 4: Run tests**

Run: `bun test packages/workspace-runtime/src/workspace-manager.integration.test.ts apps/daemon/src/worktrees.test.ts`

Expected: PASS on supported local platform.

**Step 5: Commit**

```bash
git add packages/contracts packages/workspace-runtime apps/daemon/src/worktrees.ts apps/daemon/src/worktrees.test.ts
git commit -m "feat: make workspaces durable run state"
```

### Task 19: Introduce a sandbox execution interface and platform adapters

**Files:**
- Create: `packages/contracts/src/permissions.ts`
- Create: `packages/workspace-runtime/src/sandbox/sandbox-executor.ts`
- Create: `packages/workspace-runtime/src/sandbox/linux-bwrap.ts`
- Create: `packages/workspace-runtime/src/sandbox/macos-seatbelt.ts`
- Create: `packages/workspace-runtime/src/sandbox/windows-policy.ts`
- Create: `packages/workspace-runtime/src/sandbox/sandbox.contract.test.ts`
- Modify: `apps/daemon/src/tools.ts`
- Modify: `apps/daemon/src/governed-tool-executor.ts`

**Step 1: Define permission profiles**

Canonical profiles: `read-only`, `workspace-write`, and `full-access`. Default to workspace-write with network denied and on-request approval. Persist the effective profile per run.

**Step 2: Write escape tests first**

Attempt writes outside the worktree, reads of daemon credentials, reads of `.env`, network access, process inheritance of secrets, symlink escape, `/proc/*/environ`, and private/loopback access. These must fail technically, not merely by policy classification.

**Step 3: Implement Linux and macOS adapters**

Linux uses `bubblewrap` when available and fails closed for kernel mode if enforcement cannot initialize. macOS emits a minimal Seatbelt profile. Both allow the worktree and a per-run temp directory only.

**Step 4: Implement Windows policy**

Detect the supported native mechanism. Until full enforcement exists, kernel mode permits read-only by default and requires explicit browser approval for an unsandboxed command; document the limitation in the UI and run record.

**Step 5: Route all non-provider commands through the interface**

One-off commands, Git actions that execute hooks, MCP stdio processes, and legacy raw-provider shell calls must use the sandbox executor. Codex provider turns use Codex's own configured sandbox and report the effective profile canonically.

**Step 6: Run tests**

Run: `bun test packages/workspace-runtime/src/sandbox/sandbox.contract.test.ts apps/daemon/src/governed-tool-executor.test.ts`

Expected: PASS; unsupported platform-specific suites skip with an explicit reason.

**Step 7: Commit**

```bash
git add packages/contracts packages/workspace-runtime apps/daemon/src/tools.ts apps/daemon/src/governed-tool-executor.ts apps/daemon/src/governed-tool-executor.test.ts
git commit -m "feat: enforce workspace sandbox profiles"
```

### Task 20: Deepen checkpoint and diff handling

**Files:**
- Create: `packages/workspace-runtime/src/checkpoint-manager.ts`
- Create: `packages/workspace-runtime/src/checkpoint-manager.integration.test.ts`
- Modify: `apps/daemon/src/checkpoints.ts`
- Modify: `apps/daemon/src/checkpoint-worker.ts`
- Modify: `apps/daemon/src/checkpoint-comparison-worker.ts`

**Step 1: Move existing checkpoint tests to the new interface**

Preserve hidden refs, restore-not-destroy semantics, comparison, and GC. Add baseline-before-turn and finalized-after-turn checkpoints with idempotent keys.

**Step 2: Implement orchestration-driven capture**

Checkpoint reactors receive committed turn lifecycle events; workers no longer independently claim Convex rows.

**Step 3: Add crash tests**

Crash after Git ref creation but before local receipt, and after local receipt but before Convex projection. Reconciliation must converge without duplicate checkpoints.

**Step 4: Run tests**

Run: `bun test packages/workspace-runtime/src/checkpoint-manager.integration.test.ts apps/daemon/src/checkpoints.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/workspace-runtime apps/daemon/src/checkpoints.ts apps/daemon/src/checkpoint-worker.ts apps/daemon/src/checkpoint-comparison-worker.ts
git commit -m "refactor: deepen checkpoint lifecycle module"
```

### Task 21: Add canonical history and context projections

**Files:**
- Create: `packages/contracts/src/history.ts`
- Create: `packages/orchestration/src/projections/history-projection.ts`
- Create: `packages/orchestration/src/projections/history-projection.test.ts`
- Create: `packages/harness-runtime/src/context-manager.ts`
- Create: `packages/harness-runtime/src/context-manager.test.ts`

**Step 1: Define canonical history items**

Represent user input, assistant text, activity summaries, approvals, subagent results, checkpoints, compaction artifacts, and attachments with provenance. Keep raw provider payloads out of the interface.

**Step 2: Rebuild history from events**

Write tests that replay the same event stream into an identical history snapshot and resume after a stored snapshot plus later events.

**Step 3: Implement context policy for non-session providers**

Preserve system/project instructions, active plan, unresolved review comments, last ten turns, and compaction provenance. Compact at 80% toward 40%; cap tool results and spill oversized content to local artifacts.

**Step 4: Treat Codex context as provider-owned but observable**

Persist Codex thread ID and Relay canonical history. Do not duplicate Codex's private internal context construction. Use canonical history for UI, recovery decisions, exports, and cross-provider migration.

**Step 5: Run tests**

Run: `bun test packages/orchestration/src/projections/history-projection.test.ts packages/harness-runtime/src/context-manager.test.ts`

Expected: PASS including deterministic compaction and artifact provenance.

**Step 6: Commit**

```bash
git add packages/contracts packages/orchestration packages/harness-runtime
git commit -m "feat: add durable history and context policy"
```

---

## Phase 5 — Convex command ingress and projection synchronization

### Task 22: Widen the Convex schema for command inbox and projections

**Files:**
- Modify: `convex/schema.ts`
- Create: `convex/commands/inbox.ts`
- Create: `convex/projections/events.ts`
- Create: `convex/projections/snapshots.ts`
- Create: `convex/projections/cursors.ts`
- Create: `convex/projections.convex.test.ts`
- Modify: `convex/test_helpers.ts`

**Step 1: Write schema and authorization tests**

Test user command submission, device claiming, duplicate command IDs, wrong-machine access, revoked device access, ordered projection append, duplicate event append, cursor advancement, and owner-only reads.

**Step 2: Add tables additively**

Create:

```text
commandInbox(commandId, ownerId, machineId, runId, type, payloadJson, status,
             leaseOwner, leaseExpiresAt, attempts, createdAt, completedAt)
projectionEvents(eventId, ownerId, machineId, runId, sequence, type, payloadJson,
                 occurredAt, publishedAt)
projectionSnapshots(ownerId, machineId, runId, sequence, snapshotJson, updatedAt)
projectionCursors(machineId, direction, sequence, updatedAt)
```

Add indexes for machine/status/lease, run/sequence, owner/run, and unique lookup fields. Because Convex does not provide unique indexes, enforce uniqueness transactionally with `.unique()` lookups.

**Step 3: Keep legacy tables untouched**

This is the widen deploy. New fields remain optional where existing data is involved; new tables can use required fields.

**Step 4: Run tests and code generation**

Run: `bunx convex codegen && bun run --cwd convex test:convex`

Expected: PASS with no existing test regressions.

**Step 5: Commit**

```bash
git add convex
git commit -m "feat: widen Convex for kernel synchronization"
```

### Task 23: Implement daemon command-inbox synchronization

**Files:**
- Create: `apps/daemon/src/sync/convex-command-source.ts`
- Create: `apps/daemon/src/sync/convex-command-source.integration.test.ts`
- Modify: `apps/daemon/src/relay-client.ts`
- Modify: `apps/daemon/src/index.ts`

**Step 1: Write lease and redelivery tests**

Claim a bounded batch, allow a lease to expire, redeliver to a restarted daemon, and prove the local command receipt prevents duplicate effect.

**Step 2: Implement one synchronization loop**

Prefer a long-lived reactive Convex client/subscription when supported by the Node client. If the daemon must poll, use one adaptive loop over `commandInbox`, not one loop per work type: back off while idle, wake on activity, and renew only active leases.

**Step 3: Validate untrusted payloads**

Parse `payloadJson` with `@relay/contracts` before local persistence. Invalid commands are terminally rejected with a redacted reason and never reach the orchestrator.

**Step 4: Add graceful shutdown**

Stop accepting claims, drain local accepted commands to a deadline, release unstarted leases, then close the Convex connection.

**Step 5: Run tests**

Run: `bun test apps/daemon/src/sync/convex-command-source.integration.test.ts`

Expected: PASS including restart and duplicate delivery.

**Step 6: Commit**

```bash
git add apps/daemon/src/sync apps/daemon/src/relay-client.ts apps/daemon/src/index.ts
git commit -m "feat: synchronize durable remote commands"
```

### Task 24: Publish the local projection outbox to Convex

**Files:**
- Create: `apps/daemon/src/sync/convex-projection-sink.ts`
- Create: `apps/daemon/src/sync/convex-projection-sink.integration.test.ts`
- Modify: `apps/daemon/src/relay-client.ts`

**Step 1: Write projection convergence tests**

Cover ordered batches, duplicate sends, partial batch failure, lost response after successful mutation, daemon restart, stale snapshot, and out-of-order event rejection.

**Step 2: Implement bounded batch publishing**

Publish small event batches under Convex document/function limits. Convex accepts an event only when it is the next sequence or an exact duplicate. Snapshot publication may advance only after all events through its sequence exist.

**Step 3: Implement local acknowledgement**

Advance the local outbox cursor only after Convex confirms the durable highest contiguous sequence.

**Step 4: Add payload redaction and size policy**

Cloud projections contain canonical summaries and bounded deltas. Oversized command output, raw provider events, prompts marked local-only, and artifacts remain local and publish typed references/availability metadata.

**Step 5: Run tests**

Run: `bun test apps/daemon/src/sync/convex-projection-sink.integration.test.ts`

Expected: PASS and eventual projection equality after every injected failure.

**Step 6: Commit**

```bash
git add apps/daemon/src/sync apps/daemon/src/relay-client.ts
git commit -m "feat: publish ordered harness projections"
```

### Task 25: Dual-write and backfill existing Relay threads

**Files:**
- Modify: `convex/schema.ts`
- Create: `convex/migrations.ts`
- Modify: `convex/conversations.ts`
- Modify: `convex/events.ts`
- Modify: `convex/approvals.ts`
- Test: `convex/migrations.convex.test.ts`

**Step 1: Install and configure `@convex-dev/migrations`**

Use the migration module for bounded, resumable, cursor-driven backfills. Do not write a `.collect()` migration.

**Step 2: Deploy dual-write behavior**

New browser actions write the legacy table and `commandInbox` with the same correlation ID. Legacy display queries remain authoritative during this deploy.

**Step 3: Add a dry-run backfill**

Convert existing thread/message/event/approval/checkpoint metadata into initial projection snapshots. Mark imported sequences and source document IDs so reruns are idempotent.

**Step 4: Verify locally**

Run: `bun run --cwd convex test:convex`

Expected: migration tests pass for partial, repeated, and mixed old/new data.

**Step 5: Production rollout procedure**

Run:

```bash
npx convex run migrations:backfillRunProjection '{"dryRun":true}'
npx convex run migrations:backfillRunProjection
npx convex run migrations:verifyRunProjection
```

Expected: zero unmigrated active runs and no sequence gaps. Do not narrow yet.

**Step 6: Commit**

```bash
git add package.json bun.lock convex
git commit -m "feat: dual-write and backfill run projections"
```

### Task 26: Fix authorization and ownership drift before cutover

**Files:**
- Modify: `convex/approvals.ts`
- Modify: `convex/subagents.ts`
- Modify: `convex/schema.ts`
- Modify: `convex/auth_helpers.ts`
- Modify: `apps/daemon/src/relay-client.ts`
- Test: `convex/approvals.convex.test.ts`
- Test: `convex/subagents.convex.test.ts`
- Create: `apps/daemon/src/approval-convex.e2e.test.ts`

**Step 1: Reproduce the daemon approval-auth failure**

Add a real Convex test in which a device creates an approval, a browser owner resolves it, and the device reads the resolution using device credentials rather than user auth.

**Step 2: Add a device-scoped resolution query**

Require `deviceToken` plus approval ID and verify the approval belongs to a thread on that exact machine. Keep the browser query owner-scoped.

**Step 3: Scope roles**

Add optional `ownerId` and `projectId` during widening. Seed roles per owner or project according to the documented policy; prevent one user from reading/updating another user's roles.

**Step 4: Backfill and verify roles**

Use a bounded migration; dual-read legacy global roles only until every owner has a scoped copy.

**Step 5: Run tests**

Run: `bun test apps/daemon/src/approval-convex.e2e.test.ts && bun run --cwd convex test:convex`

Expected: device/browser approval round trip passes and cross-owner tests fail closed.

**Step 6: Commit**

```bash
git add convex apps/daemon/src/relay-client.ts apps/daemon/src/approval-convex.e2e.test.ts
git commit -m "fix: scope approvals and roles correctly"
```

### Task 27: Paginate and bound growing Convex reads

**Files:**
- Modify: `convex/conversations.ts`
- Modify: `convex/events.ts`
- Modify: `convex/approvals.ts`
- Modify: `convex/audit_log.ts`
- Modify: `convex/commands.ts`
- Modify: `convex/checkpoints.ts`
- Modify: `convex/subagents.ts`
- Modify: `convex/schema.ts`
- Test: matching `*.convex.test.ts` files

**Step 1: Add large-history tests**

Seed more than one page of messages, events, approvals, audit entries, commands, checkpoints, and subagent runs. Verify stable ordering and cursor continuation.

**Step 2: Add required indexes**

Replace scan-plus-filter paths such as unresolved comments with compound indexes. Follow widen/backfill/switch-read ordering where optional fields participate.

**Step 3: Replace unbounded `.collect()` on user-growing tables**

Use Convex pagination or explicit bounded windows. Keep small configuration tables bounded with documented maximums.

**Step 4: Separate high-churn state**

Move machine heartbeat/presence and streaming cursor fields away from stable profile/run documents where they cause broad invalidation.

**Step 5: Run tests and inspect read sets**

Run: `bun run --cwd convex test:convex`

Expected: PASS; no user-growing list query in the affected flows calls unbounded `.collect()`.

**Step 6: Commit**

```bash
git add convex
git commit -m "perf: bound Relay projection queries"
```

---

## Phase 6 — Shared client runtime and browser cutover

### Task 28: Build snapshot-plus-sequence client state

**Files:**
- Create: `packages/client-runtime/src/connection-state.ts`
- Create: `packages/client-runtime/src/run-cache.ts`
- Create: `packages/client-runtime/src/event-reducer.ts`
- Create: `packages/client-runtime/src/sync-supervisor.ts`
- Create: `packages/client-runtime/src/client-runtime.integration.test.ts`
- Modify: `packages/client-runtime/src/index.ts`

**Step 1: Write sync tests**

Cover cold snapshot, event continuation, overlap deduplication, gap detection, stale snapshot, offline cache, reconnect with backoff, credential refresh, and switching active runs.

**Step 2: Separate connection from data freshness**

Model transport state (`connecting|online|offline|unauthorized`) separately from run cache state (`empty|hydrating|current|stale|gap`).

**Step 3: Implement snapshot then event resume**

Hydrate the newest authorized snapshot, subscribe after its sequence, discard exact duplicates, and force snapshot refresh on gaps.

**Step 4: Implement command submission**

Generate a stable command ID before network submission. Retry with the same ID until receipt/projection confirms acceptance.

**Step 5: Run tests**

Run: `bun test packages/client-runtime/src/client-runtime.integration.test.ts`

Expected: PASS with deterministic fake transport.

**Step 6: Commit**

```bash
git add packages/client-runtime
git commit -m "feat: add resumable Relay client runtime"
```

### Task 29: Move thread React orchestration behind client-runtime

**Files:**
- Create: `apps/web/src/runtime/relay-runtime-provider.tsx`
- Create: `apps/web/src/runtime/use-run.ts`
- Create: `apps/web/src/runtime/use-run-commands.ts`
- Modify: `apps/web/src/thread-view.tsx`
- Modify: `apps/web/src/app.tsx`
- Test: `apps/web/src/thread-view.runtime.test.tsx`

**Step 1: Write public rendering and command tests**

Render snapshots plus canonical events through a fake client runtime. Assert send, steer, stop, approval, restore, review, Git, and subagent actions submit stable commands without direct Convex references in `thread-view.tsx`.

**Step 2: Add the React provider**

The provider owns one client-runtime instance. Hooks select state and submit commands; UI modules render and collect input only.

**Step 3: Migrate incrementally**

Move messages/activity first, then approvals/checkpoints/usage/subagents/MCP/Git. Preserve legacy hooks behind runtime mode until parity tests pass.

**Step 4: Run web tests**

Run: `bun test apps/web/src/thread-view.runtime.test.tsx apps/web/src/*.test.tsx`

Expected: PASS and direct `makeFunctionReference` declarations for run workflow leave `thread-view.tsx`.

**Step 5: Commit**

```bash
git add apps/web packages/client-runtime
git commit -m "refactor: route workbench through client runtime"
```

### Task 30: Replace whole-message rewrites with ordered deltas

**Files:**
- Modify: `packages/contracts/src/events.ts`
- Modify: `convex/projections/events.ts`
- Modify: `packages/client-runtime/src/event-reducer.ts`
- Modify: `apps/web/src/thread-messages.tsx`
- Test: corresponding event/projection/client/web tests

**Step 1: Write delta idempotency tests**

Send repeated and overlapping assistant deltas. Apply each event ID once, maintain sequence order, and produce identical final text after reconnect.

**Step 2: Publish bounded deltas**

Coalesce provider-native deltas locally to the latency/size budget, then append projection events. Periodically publish compact snapshots so new clients do not replay unbounded delta history.

**Step 3: Update client reduction**

Build visible text from snapshot plus later deltas. Do not rewrite a growing Convex message document every 200 ms.

**Step 4: Run latency and correctness tests**

Run: `bun test packages/client-runtime apps/web/src/thread-messages.test.tsx && bun run --cwd convex test:convex`

Expected: first visible text remains within budget and reconnect output is byte-identical.

**Step 5: Commit**

```bash
git add packages/contracts packages/client-runtime convex apps/web/src/thread-messages.tsx apps/web/src/thread-messages.test.tsx
git commit -m "feat: stream ordered assistant deltas"
```

---

## Phase 7 — Kernel cutover and workflow closure

### Task 31: Run shadow mode and prove projection parity

**Files:**
- Create: `apps/daemon/src/shadow/shadow-runtime.ts`
- Create: `apps/daemon/src/shadow/projection-comparator.ts`
- Create: `apps/daemon/src/shadow/shadow-runtime.e2e.test.ts`
- Modify: `apps/daemon/src/index.ts`

**Step 1: Define safe shadow semantics**

Only one path may perform side effects. Legacy remains active; kernel consumes recorded inputs through fake/no-op workspace and provider adapters and produces shadow projections for comparison.

**Step 2: Compare canonical outcomes**

Normalize IDs/timestamps and compare message text, activity lifecycle, approval intent, usage, diffs, checkpoints, and terminal state. Store redacted mismatch diagnostics locally.

**Step 3: Add parity thresholds**

Require zero state-machine divergence and zero lost terminal events across the scripted suite. Text formatting differences may be allowlisted only with a documented reason.

**Step 4: Run tests**

Run: `RELAY_RUNTIME_MODE=shadow bun test apps/daemon/src/shadow/shadow-runtime.e2e.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/daemon/src/shadow apps/daemon/src/index.ts
git commit -m "test: prove kernel projection parity"
```

### Task 32: Route every workflow through the orchestration engine

**Files:**
- Modify: `apps/daemon/src/index.ts`
- Modify: `apps/daemon/src/command-worker.ts`
- Modify: `apps/daemon/src/git-worker.ts`
- Modify: `apps/daemon/src/subagent-worker.ts`
- Modify: `apps/daemon/src/mcp-registry.ts`
- Create: `apps/daemon/src/kernel-workflows.e2e.test.ts`

**Step 1: Add one end-to-end workflow test**

Drive prompt, command output, approval, MCP call, depth-one subagent, writer patch integration, checkpoint, review comment, Git stage/commit, and stop through command inbox and canonical projections.

**Step 2: Replace workers with adapters/reactors**

Keep their proven implementation logic behind new deep interfaces, but remove their independent Convex claim ownership and direct status mutations.

**Step 3: Enforce concurrency policy**

Provider turns, one-off commands, restore, and Git mutation for the same run serialize. Read-only subagents may run concurrently within configured global and per-run limits.

**Step 4: Run tests**

Run: `RELAY_RUNTIME_MODE=kernel bun test apps/daemon/src/kernel-workflows.e2e.test.ts`

Expected: PASS with no 200 ms worker intervals active.

**Step 5: Commit**

```bash
git add apps/daemon/src
git commit -m "refactor: route workflows through kernel orchestration"
```

### Task 33: Implement reviewer jury as an orchestrated workflow

**Files:**
- Create: `packages/orchestration/src/workflows/review-jury.ts`
- Create: `packages/orchestration/src/workflows/review-jury.test.ts`
- Modify: `packages/contracts/src/commands.ts`
- Modify: `convex/diff_comments.ts`
- Modify: `apps/web/src/diff-view.tsx`
- Modify: `apps/web/src/thread-view.tsx`

**Step 1: Write jury contract tests**

`review.requested` launches reviewer and reviewer-security with read-only fresh contexts, different configured provider instances, the same immutable diff/checkpoint input, and no edit/exec capability.

**Step 2: Normalize findings**

Require P0-P3 severity, file/range evidence, summary, reviewer role, run ID, and dedupe key. Persist accepted findings as inline comments.

**Step 3: Add UI command and progress**

Expose Review, show both sub-runs and partial completion, and make Address Findings submit unresolved finding IDs to a new turn.

**Step 4: Run tests**

Run: `bun test packages/orchestration/src/workflows/review-jury.test.ts apps/web/src/diff-view.test.ts apps/web/src/workbench-navigation.test.tsx && bun run --cwd convex test:convex`

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/orchestration packages/contracts convex apps/web/src
git commit -m "feat: add orchestrated review jury"
```

### Task 34: Cut default runtime to kernel and remove hot pollers

**Files:**
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/index.ts`
- Modify: `apps/daemon/src/agent-loop.ts`
- Modify: `apps/daemon/src/relay-client.ts`
- Test: `apps/daemon/src/kernel-default.test.ts`

**Step 1: Add the default-mode test**

Assert no mode defaults to kernel only after every kernel release gate is green. Assert `legacy` remains an explicit emergency rollback for one release window.

**Step 2: Remove interval registration from the kernel composition**

The daemon starts one orchestrator, one command sync source, one projection sink, provider registry, workspace runtime, and observability module.

**Step 3: Move legacy implementation behind an isolated adapter**

No new code may import legacy `runQueuedTurn` directly. Add a deprecation deadline and telemetry counter for legacy activation.

**Step 4: Run the full suite**

Run: `bun run typecheck && bun run test && bun run build`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/daemon/src
git commit -m "feat: make durable harness kernel the default"
```

---

## Phase 8 — Operational reliability and observability

### Task 35: Add structured local logs and correlation

**Files:**
- Create: `packages/contracts/src/observability.ts`
- Create: `apps/daemon/src/observability/logger.ts`
- Create: `apps/daemon/src/observability/ndjson-rotator.ts`
- Create: `apps/daemon/src/observability/redaction.ts`
- Create: `apps/daemon/src/observability/logger.test.ts`
- Modify: `apps/daemon/src/index.ts`

**Step 1: Write redaction tests**

Cover API keys, bearer tokens, device tokens, environment assignments, `.env` content, approval summaries, MCP prompts, command output, provider-native payloads, and user-marked local-only text.

**Step 2: Define the log envelope**

Include timestamp, level, module, event name, machine ID, run ID, turn ID, command ID, event ID, correlation ID, provider instance ID, duration, outcome, and a bounded redacted details object.

**Step 3: Implement always-on rotating NDJSON**

Store under daemon home with restrictive permissions, bounded file count/size, crash-safe line writes, and no raw prompts by default.

**Step 4: Replace console logging in the daemon composition and kernel modules**

Adapters accept a logger dependency; they do not import a global logger.

**Step 5: Run tests**

Run: `bun test apps/daemon/src/observability/logger.test.ts`

Expected: PASS with secrets absent from serialized output.

**Step 6: Commit**

```bash
git add packages/contracts apps/daemon/src/observability apps/daemon/src/index.ts
git commit -m "feat: add correlated redacted daemon logs"
```

### Task 36: Add metrics, health, and diagnostic export

**Files:**
- Create: `apps/daemon/src/observability/metrics.ts`
- Create: `apps/daemon/src/observability/health.ts`
- Create: `apps/daemon/src/diagnostics.ts`
- Create: `apps/daemon/src/diagnostics.test.ts`
- Modify: `apps/daemon/src/cli.ts`

**Step 1: Define bounded metrics**

Track command queue depth/latency, event append latency, outbox lag, projection gaps, provider process restarts, turn duration/outcome, approval duration, sandbox denial, checkpoint duration, worktree count, SQLite size, and active runs. Avoid user/run IDs as metric labels.

**Step 2: Add local health state**

Report database, Convex connection, outbox lag, provider availability, workspace reconciliation, sandbox readiness, version compatibility, and degraded reasons.

**Step 3: Add `relay doctor`**

Produce a redacted diagnostic archive containing versions, health, schema versions, recent logs, configuration keys without values, and Git/worktree metadata without file content.

**Step 4: Add optional OTLP export**

Disabled by default. Export traces/metrics only when configured, with the same redaction policy and bounded buffering.

**Step 5: Run tests**

Run: `bun test apps/daemon/src/diagnostics.test.ts apps/daemon/src/cli.test.ts`

Expected: PASS and diagnostic fixtures contain no secrets.

**Step 6: Commit**

```bash
git add apps/daemon/src
git commit -m "feat: add health metrics and diagnostics"
```

### Task 37: Add deterministic kill-point recovery tests

**Files:**
- Create: `apps/daemon/src/reliability/kill-points.ts`
- Create: `apps/daemon/src/reliability/crash-recovery.e2e.test.ts`
- Create: `scripts/run-crash-matrix.ts`
- Modify: `.github/workflows/ci.yml`

**Step 1: Define kill points**

At minimum:

```text
after remote claim
after local command persist
after command receipt check
after event append
after provider process start
after provider thread start
during assistant delta stream
while awaiting approval
during sandboxed command
after checkpoint ref creation
before outbox publish
after Convex commit before local acknowledgement
during graceful shutdown
```

**Step 2: Spawn the daemon as a child process**

Use durable fixture SQLite, fake provider, Git repository, and fake Convex transport. Terminate at each named point, restart, and wait on receipts rather than arbitrary sleep.

**Step 3: Assert convergence**

Every case ends in a valid recoverable or terminal state, no duplicate filesystem effect, no sequence gap, no lost approval, and no permanently leased command.

**Step 4: Add CI partitioning**

Run a fast representative subset on every PR and the full matrix nightly/release.

**Step 5: Run**

Run: `bun run scripts/run-crash-matrix.ts --profile=pr`

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/daemon/src/reliability scripts/run-crash-matrix.ts .github/workflows/ci.yml
git commit -m "test: prove daemon crash recovery"
```

### Task 38: Implement retention, compaction, and storage pressure policy

**Files:**
- Create: `packages/local-store/src/retention.ts`
- Create: `packages/local-store/src/compaction.ts`
- Create: `packages/local-store/src/retention.integration.test.ts`
- Create: `apps/daemon/src/storage-pressure.ts`
- Create: `apps/daemon/src/storage-pressure.test.ts`
- Modify: `apps/daemon/src/config.ts`

**Step 1: Define retention policy**

Separate active runs, archived runs, acknowledged outbox rows, raw provider logs, artifacts, checkpoints, diagnostic logs, and snapshots. Never delete the only state needed to resume an active run.

**Step 2: Write pressure tests**

Simulate database/artifact limits, disk-full before transaction, disk-full during artifact write, and retention interruption. Relay must pause new mutating work before corrupting state.

**Step 3: Implement bounded compaction**

Create snapshots, verify replay hash, then prune events only where the product retention contract permits. Keep audit/security records according to explicit policy.

**Step 4: Surface warnings**

Project storage state to the browser and `relay doctor`; include operator actions.

**Step 5: Run tests**

Run: `bun test packages/local-store/src/retention.integration.test.ts apps/daemon/src/storage-pressure.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/local-store apps/daemon/src
git commit -m "feat: manage harness storage retention"
```

---

## Phase 9 — Security closure

### Task 39: Write and test the Relay threat model

**Files:**
- Create: `docs/security/threat-model.md`
- Create: `docs/security/security-invariants.md`
- Create: `apps/daemon/src/security/security-invariants.test.ts`
- Create: `convex/security.convex.test.ts`

**Step 1: Enumerate trust zones**

Browser, Convex deployment, daemon, provider process, sandboxed child process, project repository, daemon home, MCP server, remote network, artifact/log store, and release channel.

**Step 2: Enumerate threats**

Compromised account, stolen device token, malicious prompt, malicious repository instructions, provider event injection, command replay, symlink/path escape, sandbox escape, secret exfiltration, MCP schema/payload abuse, cross-user access, supply-chain replacement, downgrade, and log leakage.

**Step 3: Link each threat to an enforceable invariant and test**

Do not accept prose-only mitigations when a seam can enforce them.

**Step 4: Run security suites**

Run: `bun test apps/daemon/src/security/security-invariants.test.ts && bun run --cwd convex test:convex`

Expected: PASS.

**Step 5: Commit**

```bash
git add docs/security apps/daemon/src/security convex/security.convex.test.ts
git commit -m "docs: codify Relay threat model"
```

### Task 40: Harden secrets, credentials, and device identity

**Files:**
- Modify: `apps/daemon/src/device-credentials.ts`
- Modify: `apps/daemon/src/config.ts`
- Create: `apps/daemon/src/secret-store.ts`
- Create: `apps/daemon/src/secret-store.test.ts`
- Modify: `convex/machines.ts`
- Modify: `convex/pairing.ts`

**Step 1: Add credential lifecycle tests**

Cover restrictive permissions, rotation, revocation, expiry, old-token rejection, interrupted rotation, missing keyring, and redacted errors.

**Step 2: Add a secret-store interface**

Use OS credential storage where supported; retain an owner-only encrypted/file fallback with explicit warnings and no secrets in SQLite/Convex/logs.

**Step 3: Add token rotation and daemon identity**

Pairing issues a scoped machine credential with creation/version metadata. Support rotate-before-expiry and immediate revocation. Never put raw credentials in shell argv.

**Step 4: Run tests**

Run: `bun test apps/daemon/src/secret-store.test.ts apps/daemon/src/device-credentials.test.ts && bun run --cwd convex test:convex`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/daemon/src convex/machines.ts convex/pairing.ts
git commit -m "feat: harden daemon credentials"
```

### Task 41: Complete authorization and audit semantics

**Files:**
- Modify: `convex/auth_helpers.ts`
- Modify: `convex/audit_log.ts`
- Modify: `convex/schema.ts`
- Create: `convex/authorization-matrix.convex.test.ts`
- Modify: `packages/contracts/src/permissions.ts`

**Step 1: Define the actor-resource matrix**

User, device, provider, subagent, and system actors against machine/project/run/approval/role/MCP/checkpoint/Git resources.

**Step 2: Add exhaustive authorization tests**

Every public/device function receives positive owner and negative cross-owner/revoked/wrong-machine tests.

**Step 3: Enrich audit records**

Record actor kind/ID, command/event/correlation IDs, policy version, effective permission profile, decision source, scope, redacted summary, and timestamp. Keep audit records append-only.

**Step 4: Add bounded audit export**

Owner-authorized, paginated, and explicitly redacted.

**Step 5: Run tests**

Run: `bun run --cwd convex test:convex`

Expected: PASS with the complete matrix.

**Step 6: Commit**

```bash
git add convex packages/contracts/src/permissions.ts
git commit -m "feat: enforce authorization and audit matrix"
```

### Task 42: Run an adversarial security validation gate

**Files:**
- Create: `scripts/security-gate.ts`
- Create: `docs/security/security-test-plan.md`
- Modify: `.github/workflows/ci.yml`

**Step 1: Add automated cases**

Path traversal, symlink swap, command injection, malformed provider JSON-RPC, oversized events, duplicate/reordered commands, cross-user IDs, revoked tokens, malicious MCP schemas, hostile Git hooks, secret echoes, and sandbox escape attempts.

**Step 2: Add dependency and artifact checks**

Audit lockfile, verify release checksums, scan compiled binaries for known secret fixtures, and confirm installers use pinned release assets.

**Step 3: Add manual review checklist**

Require independent review of sandbox profiles, auth helpers, secret store, update verification, and all full-access escape paths before release.

**Step 4: Run**

Run: `bun run scripts/security-gate.ts`

Expected: PASS with a machine-readable report and zero critical/high unresolved findings.

**Step 5: Commit**

```bash
git add scripts/security-gate.ts docs/security .github/workflows/ci.yml
git commit -m "test: add production security gate"
```

---

## Phase 10 — Distribution, upgrades, backup, and compatibility

### Task 43: Add a daemon process supervisor contract

**Files:**
- Create: `docs/operations/process-supervision.md`
- Create: `scripts/install-service.ts`
- Modify: `scripts/install.sh`
- Modify: `scripts/install.ps1`
- Create: `scripts/install-service.test.ts`

**Step 1: Define supported service managers**

Launchd on macOS, systemd user service on Linux where available, and Windows Service or Task Scheduler according to privilege constraints. Document foreground fallback.

**Step 2: Add installer generation tests**

Assert restart policy, working directory, environment/credential handling, log destination, graceful-stop timeout, and uninstall behavior.

**Step 3: Implement service installation**

Never embed device tokens into world-readable service definitions. Reference the daemon secret store.

**Step 4: Test install/uninstall in CI images where possible**

Run: `bun test scripts/install-service.test.ts scripts/install.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add docs/operations scripts
git commit -m "feat: install Relay as a supervised daemon"
```

### Task 44: Implement version compatibility and safe upgrades

**Files:**
- Create: `packages/contracts/src/versioning.ts`
- Create: `apps/daemon/src/version-compatibility.ts`
- Create: `apps/daemon/src/updater.ts`
- Create: `apps/daemon/src/updater.test.ts`
- Modify: `convex/machines.ts`
- Modify: `apps/web/src/machine-sidebar.tsx`
- Modify: `scripts/build-release.ts`

**Step 1: Define compatibility contract**

Track daemon version, contract version, local schema version, provider schema version, minimum supported web/Convex version, and migration state.

**Step 2: Write update verification tests**

Cover signed manifest/checksum, wrong platform, downgrade, interrupted download, corrupt artifact, incompatible local schema, active runs, and rollback to previous binary.

**Step 3: Implement staged upgrade**

Download to a staging path, verify, stop accepting new runs, drain/checkpoint active work, back up metadata, install atomically, restart, run health check, and roll back on failure.

**Step 4: Surface compatibility in UI**

Show healthy, upgrade available, incompatible, migrating, and rollback states with operator guidance.

**Step 5: Run tests**

Run: `bun test apps/daemon/src/updater.test.ts && bun run build`

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/contracts apps/daemon/src convex/machines.ts apps/web/src/machine-sidebar.tsx scripts/build-release.ts
git commit -m "feat: add safe daemon upgrades"
```

### Task 45: Add backup, restore, and corruption recovery

**Files:**
- Create: `apps/daemon/src/backup.ts`
- Create: `apps/daemon/src/backup.integration.test.ts`
- Modify: `apps/daemon/src/cli.ts`
- Create: `docs/operations/backup-recovery.md`

**Step 1: Define backup scope**

SQLite snapshot, provider session metadata, workspace registry, policy/config without secret values, checkpoint refs inventory, and artifact manifest. Git repositories themselves remain user-managed.

**Step 2: Implement `relay backup`**

Use SQLite's consistent backup mechanism, version the manifest, checksum files, and write atomically.

**Step 3: Implement `relay restore --verify` and `relay restore`**

Verify compatibility/checksums before mutation. Restore into a staging daemon home, reconcile worktrees/checkpoints, then swap atomically.

**Step 4: Add corruption tests**

Truncated DB, missing artifact, future schema, mismatched checkpoint repo, partial backup, and interrupted restore.

**Step 5: Run tests**

Run: `bun test apps/daemon/src/backup.integration.test.ts apps/daemon/src/cli.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/daemon/src docs/operations/backup-recovery.md
git commit -m "feat: add daemon backup and recovery"
```

---

## Phase 11 — Performance, scale, and production acceptance

### Task 46: Establish service-level objectives and load profiles

**Files:**
- Create: `docs/operations/slo.md`
- Create: `scripts/load-harness.ts`
- Create: `scripts/load-convex-projections.ts`
- Create: `scripts/load-client-runtime.ts`
- Modify: `package.json`

**Step 1: Define initial SLOs**

At minimum: command acceptance, prompt-to-first-visible-delta, steering acknowledgement, approval round trip, outbox lag, reconnect catch-up, crash recovery, provider restart, checkpoint duration, and browser interaction responsiveness.

**Step 2: Define profiles**

Single developer, power user with 20 active runs, multiple machines, long-running 100k-event run, bursty command submission, offline daemon catch-up, and slow Convex/provider network.

**Step 3: Implement deterministic generators**

Use fake providers and generated canonical events; do not spend real model tokens for load tests.

**Step 4: Add pass/fail budgets**

Run: `bun run load:harness --profile=ci`

Expected: no sequence gaps, bounded memory/queue growth, and all CI SLO thresholds pass.

**Step 5: Commit**

```bash
git add docs/operations/slo.md scripts package.json
git commit -m "test: establish Relay production SLOs"
```

### Task 47: Optimize from measured signals

**Files:**
- Modify: files identified by load/Convex insights only
- Create: `docs/operations/performance-baseline.md`

**Step 1: Capture baseline**

Run local load profiles and `npx convex insights --details` against the target deployment. Record queue depth, read/write counts, bytes, subscription count, invalidations, memory, CPU, database growth, and p50/p95/p99 latency.

**Step 2: Fix the highest measured bottleneck first**

Likely candidates are projection batch sizing, snapshot cadence, broad reactive queries, heartbeat invalidation, event replay memory, or SQLite indexes. Do not introduce digest tables or denormalization without evidence.

**Step 3: Add a regression test for each optimization**

Behavior must remain identical; fallback paths must handle partially migrated data.

**Step 4: Re-run baseline**

Expected: documented improvement with no SLO regression elsewhere.

**Step 5: Commit**

```bash
git add docs/operations/performance-baseline.md <measured-fix-files>
git commit -m "perf: meet Relay production SLOs"
```

### Task 48: Run the supported OS and provider conformance matrix

**Files:**
- Create: `scripts/run-conformance-matrix.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Create: `docs/operations/support-matrix.md`

**Step 1: Define matrix**

Linux x64/arm64, macOS x64/arm64, Windows x64; Git versions; sandbox readiness; Codex app-server pinned version; fresh install; upgrade from previous release; reconnect after sleep/network loss.

**Step 2: Run common HarnessRuntime contract**

The fake runs everywhere. Codex real smoke runs in protected jobs where credentials are available. Platform sandbox suites run only on their target OS and must report enforcement status.

**Step 3: Build and smoke compiled binaries**

Verify schema assets, migrations, SQLite, service install, doctor, backup, and graceful shutdown in compiled output.

**Step 4: Publish support status**

Do not label a platform supported until install, kernel workflow, sandbox policy, restart, upgrade, and uninstall all pass.

**Step 5: Commit**

```bash
git add scripts/run-conformance-matrix.ts .github/workflows docs/operations/support-matrix.md
git commit -m "ci: enforce Relay support matrix"
```

### Task 49: Execute the production acceptance scenario

**Files:**
- Create: `apps/daemon/src/production-acceptance.e2e.test.ts`
- Create: `apps/web/e2e/production-acceptance.e2e-spec.ts`
- Create: `docs/operations/production-readiness-checklist.md`
- Create: `docs/operations/incident-runbook.md`

**Step 1: Automate the scenario**

```text
install and pair a daemon
create two isolated runs in one repository
stream multi-step Codex work
steer one run
approve one request and deny another from the browser
spawn read-only and writer subagents
disconnect Convex and continue local recovery-safe work
kill the daemon during a turn and restart it
resume without duplicate effects or lost activity
run the reviewer jury and address findings
compare and restore checkpoints
stage, commit, and push to a fixture remote
upgrade the daemon
verify history, audit, worktrees, and secrets
uninstall without deleting user repositories
```

**Step 2: Run backend acceptance**

Run: `bun test apps/daemon/src/production-acceptance.e2e.test.ts`

Expected: PASS.

**Step 3: Run browser acceptance**

Run: `bunx playwright test apps/web/e2e/production-acceptance.e2e-spec.ts`

Expected: PASS on desktop and mobile viewport; mobile browser supervision does not imply a native mobile app.

**Step 4: Complete readiness review**

Require zero unresolved P0/P1 correctness or security findings, all release gates green, documented rollback, current backups tested, alerts/runbook reviewed, and support matrix published.

**Step 5: Commit**

```bash
git add apps/daemon/src/production-acceptance.e2e.test.ts apps/web/e2e docs/operations
git commit -m "test: certify Relay production readiness"
```

### Task 50: Narrow schemas and remove the legacy runtime

**Files:**
- Modify: `convex/schema.ts`
- Modify: `convex/conversations.ts`
- Modify: `convex/events.ts`
- Modify: `convex/commands.ts`
- Delete: legacy-only daemon workers and tests after replacement coverage is proven
- Modify: `packages/shared/src/index.ts`
- Modify: `tickets.md`

**Step 1: Verify migration completion in production**

No active run depends on legacy tables, no legacy runtime activation has occurred during the agreed release window, all outbox cursors are current, and rollback backup is verified.

**Step 2: Switch reads and writes exclusively to kernel projections**

Deploy this separately before deleting fields/tables. Monitor error rate, projection lag, auth failures, and runtime-mode telemetry.

**Step 3: Narrow Convex schema**

Remove deprecated optional fields only after bounded migrations report zero remaining documents. Preserve historical audit data or export it according to retention policy.

**Step 4: Delete the legacy loop and pollers**

Use the deletion test: complexity must remain concentrated in `HarnessRuntime`, orchestration, provider, workspace, and sync modules rather than reappearing in callers.

**Step 5: Run final verification**

Run:

```bash
bun run typecheck
bun run test
bun run build
bun run bundle:check
bun run scripts/security-gate.ts
bun run scripts/run-crash-matrix.ts --profile=release
bun run scripts/run-conformance-matrix.ts
```

Expected: all pass; no source import references deleted legacy modules.

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: complete Relay harness kernel migration"
```

---

## Rollout and rollback rules

1. **Every phase is releasable.** Main must stay green and the legacy path must remain usable until Task 34.
2. **Never dual-execute side effects.** Shadow mode may compare decisions/projections but cannot run a second provider turn or workspace mutation.
3. **Convex changes deploy in separate widen, migrate, read-cutover, and narrow releases.** Do not combine these into one production deploy.
4. **Local schema migrations back up metadata first and are forward-only during normal startup.** Binary rollback must understand the post-migration schema or restore the verified pre-upgrade backup.
5. **Runtime cutover is per machine.** Start with developer machines, then opt-in canary machines, then default kernel. Keep emergency legacy activation for one release window only.
6. **Stop rollout on invariant violations.** Sequence gaps, duplicate side effects, cross-owner access, sandbox escape, unrecoverable active runs, or projection divergence are automatic rollback conditions.

## Testing pyramid after migration

- **Pure contract tests:** schemas, reducers, decider, normalization, permission policy.
- **Module interface tests:** HarnessRuntime, ProviderSessionAdapter, WorkspaceManager, SandboxExecutor, EventStore, ClientRuntime.
- **Local integration tests:** real SQLite, real Git worktrees/checkpoints, fixture provider process, fake Convex transport.
- **Convex tests:** authorization, command leases, idempotent projection append, pagination, migrations.
- **Cross-tier E2E:** browser/Convex/daemon/fake provider on every PR.
- **Protected provider E2E:** real Codex app-server smoke on nightly/release.
- **Reliability tests:** crash matrix, network partition, disk pressure, duplicate/reordered transport.
- **Security tests:** authorization matrix, sandbox escape suite, secret scanning, hostile input corpus.
- **Release tests:** compiled binary, fresh install, upgrade, backup/restore, supervisor, uninstall, OS matrix.

## Plan completion checklist

- [ ] Tasks 1-13 establish deep kernel modules and durable orchestration.
- [ ] Tasks 14-17 establish and verify the Codex provider adapter.
- [ ] Tasks 18-21 make workspace, sandbox, checkpoint, and history state durable.
- [ ] Tasks 22-27 complete safe Convex widening, synchronization, auth fixes, migration, and bounded reads.
- [ ] Tasks 28-34 cut browser and daemon workflows to the kernel without a big-bang rewrite.
- [ ] Tasks 35-38 prove operational reliability and observability.
- [ ] Tasks 39-42 close the security model.
- [ ] Tasks 43-45 make install, upgrade, backup, and recovery operable.
- [ ] Tasks 46-50 certify performance, OS support, production acceptance, and legacy removal.

## Execution handoff

Execute this plan in dedicated worktrees by phase, not as one long-lived branch. Use `superpowers:executing-plans` for each phase and run code review at every phase gate. Phase 0 and Phase 1 are the first implementation batch; do not begin Codex adapter work until the canonical contracts and local durability interfaces are green.
