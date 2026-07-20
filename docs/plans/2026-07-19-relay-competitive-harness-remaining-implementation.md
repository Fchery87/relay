# Relay Competitive Harness Remaining Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use a dedicated worktree per phase and request code review at every phase gate.

**Goal:** Finish Relay's migration from a partially wired durable kernel into a competitive, secure, recoverable, browser-supervised coding harness, then ship Relay-specific capabilities that terminal-only harnesses cannot match.

**Architecture:** The local daemon remains the execution authority. Commands enter through Convex, one local orchestration engine owns state transitions, durable reactors execute side effects, and a transactional outbox publishes redacted canonical projections back to Convex. Providers, workspaces, tools, clients, and extensions integrate through deep contracts rather than mutating run state directly.

**Tech Stack:** Bun, TypeScript, SQLite/WAL, Convex, React/Vite, Codex app-server JSON-RPC over stdio, Git worktrees, platform sandbox adapters, Vitest/Bun test, Playwright.

**Status:** Ready for implementation

**Date:** 2026-07-19

**Authority:** `.scratch/harness-kernel/PRD.md`, ADRs 0001-0003, and `docs/plan/relay-competitive-harness-implementation-plan.md`

---

## 1. Current baseline

Commits `66beecb`, `353c47b`, and `7333bbd` completed the first durable-kernel increment. Do not rebuild this foundation:

- atomic command receipts, events, snapshots, outbox rows, and effect intents;
- per-run FIFO orchestration with bounded cross-run concurrency;
- leased reactors, durable retries, backoff, recovery, and shutdown fencing;
- strict canonical ingress validation and reducer-owned run state;
- ordered live observation and deterministic replay;
- persisted turn, approval, workspace, provider, checkpoint, and permission metadata;
- corruption quarantine and replayable terminal repair;
- provider-gated approval resolution;
- Codex native thread/turn identity fencing in the current daemon bridge.

Several later-phase files already exist but are scaffolds, not completed features:

| Area | Existing code | Remaining truth gap |
|---|---|---|
| Runtime conformance | `harness-runtime.contract.test.ts` | Runs only against the fake and does not cover restart, approval gating, cancellation, or durable reactors |
| Provider runtime | `packages/provider-runtime/src/index.ts` | Empty; no driver, registry, session contract, or tool bridge |
| Codex transport | `codex-transport.ts` | Drops input under load, cannot answer server requests, lacks supervision and protocol compatibility |
| Codex adapter | `codex-session-adapter.ts` | One mutable active thread; not a durable per-run session registry |
| Normalization | `normalize-event.ts` | Partial and still centered on simplified notification names instead of the complete generated v2 surface |
| History/context | `history.ts`, `context-manager.ts` | No event projection; compaction is a count summary, not a semantic durable artifact |
| Workspace/checkpoints | `workspace-manager.ts`, `checkpoint-manager.ts` | Records exist, but Git reconciliation and actual restore/capture are stubs |
| Tools/governance | daemon tool files | Scattered unions; advertised tools can be pass-through or missing executors; no technical sandbox boundary |
| Convex synchronization | command/projection modules | Basic tables and mutations exist; production leases, cursor convergence, migration, and browser cutover are incomplete |
| Client runtime | `client-runtime.ts` | Basic fetch/catch-up only; no subscription supervisor, offline state, stable command IDs, or React adoption |
| Workflows | `orchestration/src/workflows.ts` | Explicit throwing stubs |
| Shadow mode | `shadow-runner.ts` | Comparator utility only; the active shadow daemon can still run two claim paths |
| Observability/operations | local-store modules | In-memory counters and backup/supervisor stubs, not production facilities |

Unrelated generated Convex AI files and `.claude/skills` working-tree changes are outside this plan and must not be overwritten or staged accidentally.

---

## 2. Program gates and execution order

```text
G1 Runtime Contract
  -> G2 Real Durable Codex Turn
  -> G3 Canonical History + Safety
  -> G4 Projection Parity
  -> G5 Competitive Floor
  -> G6 Operational Readiness
  -> G7 Kernel Default
  -> G8 Relay Edge
```

Rules:

1. Never dual-execute a provider, tool, Git, or workspace side effect in shadow mode.
2. Never add a second real provider before the fake and Codex pass the same runtime/provider contracts.
3. Every stateful task includes duplicate delivery, cancellation, restart, and stale-generation coverage.
4. Every external or persisted boundary uses runtime schemas and bounded payloads.
5. Every phase lands as a releasable commit series; Convex widening, migration, read cutover, and narrowing are separate deployments.
6. Stop rollout on sequence gaps, duplicate effects, wrong-run events, cross-owner access, sandbox escape, unrecoverable active runs, or projection divergence.

### Remaining phase map

| Phase | Gate | Depends on | Primary outcome |
|---|---|---|---|
| A. Contract closure | G1 | durable kernel baseline | Fake and local runtime obey one complete lifecycle contract |
| B. Real Codex reactor | G2 | G1 | Browser-originated Codex turn survives provider/daemon failure |
| C. History/context/artifacts | part of G3 | G1 | Long runs retain goals and export provider-independent history |
| D. Workspace/sandbox/tools | G3 | G1 | Every advertised action is real, governed, and technically confined |
| E. Projection/client cutover | G4 | G2, G3 | Browser is an exact resumable projection of local authority |
| F. Workflows/task graph | G5 | G4 | Parallel agents and all workflows run through orchestration |
| G. Extension platform | Extensible Platform | G5 | Existing extensibility uses stable governed kernel APIs |
| H. Reliability/security/ops | G6 | G2-G5 | Recovery, security, diagnostics, backup, and supervision are proven |
| I. Acceptance/cutover | G7 | G6 | Kernel becomes default, then legacy is safely removed |
| J. Relay edge | G8 | G7 | Time travel, visual orchestration, handoff, and comparison |

After G1, Phases B, C, and D may use separate worktrees and proceed in
parallel. Phase E waits for the real provider and safety gates. Reliability
instrumentation from Phase H should be added alongside each stateful phase,
but G6 cannot close until the complete active path exists.

---

## Phase A — Close the runtime and provider contracts

### Task A1: Turn the HarnessRuntime tests into a reusable conformance suite

**Files:**

- Modify: `packages/harness-runtime/src/harness-runtime.contract.test.ts`
- Modify: `packages/harness-runtime/src/fake-harness-runtime.ts`
- Modify: `packages/harness-runtime/src/local-harness-runtime.ts`
- Modify: `packages/harness-runtime/src/local-harness-runtime.integration.test.ts`
- Create: `packages/harness-runtime/src/harness-runtime.contract.ts`

**Steps:**

1. Extract `runHarnessRuntimeContract(name, createFixture)` from the fake-only test.
2. Define fixture controls for `drain`, `close`, `reopen`, scripted provider events, and an injectable clock.
3. Add failing contract cases for full lifecycle, live observation, exact cursor resume, provider-gated approval, steering, interrupt, stop, duplicate command identity, two-run isolation, reactor retry, shutdown, and restart.
4. Run the suite against `FakeHarnessRuntime` and `LocalHarnessRuntime`; remove fake-only behavior that contradicts reducer or turn semantics.
5. Run:

   ```bash
   bun test packages/harness-runtime/src/harness-runtime.contract.test.ts \
     packages/harness-runtime/src/local-harness-runtime.integration.test.ts
   ```

6. Commit:

   ```bash
   git add packages/harness-runtime
   git commit -m "test(kernel): share the complete runtime contract"
   ```

**Done when:** Both implementations pass identical black-box tests without conditional expectations.

### Task A2: Define the provider driver, session, registry, and conformance contracts

**Files:**

- Modify: `packages/provider-runtime/src/index.ts`
- Create: `packages/provider-runtime/src/provider-driver.ts`
- Create: `packages/provider-runtime/src/provider-session.ts`
- Create: `packages/provider-runtime/src/provider-registry.ts`
- Create: `packages/provider-runtime/src/provider-runtime.contract.ts`
- Create: `packages/provider-runtime/src/provider-runtime.contract.test.ts`
- Modify: `packages/contracts/src/ids.ts`
- Modify: `packages/contracts/src/state.ts`

**Contract shape:**

```ts
interface ProviderDriver<TConfig> {
  inspect(config: unknown): Promise<ProviderAvailability>;
  create(config: TConfig, scope: ProviderSessionScope): Promise<ProviderSession>;
}

interface ProviderSession {
  start(): Promise<ProviderSessionReceipt>;
  resume(receipt: ProviderSessionReceipt): Promise<void>;
  send(input: ProviderTurnInput): Promise<ProviderTurnReceipt>;
  steer(input: ProviderSteerInput): Promise<void>;
  interrupt(input: ProviderInterruptInput): Promise<void>;
  resolveRequest(input: ProviderRequestResolution): Promise<void>;
  stop(reason: string): Promise<void>;
  events(signal: AbortSignal): AsyncIterable<ScopedProviderEvent>;
}
```

**Steps:**

1. Write failing contract tests for start/resume/send/terminal, approval/server request, cancellation, duplicate event identity, stale native turns, process loss, and two simultaneous sessions.
2. Make session scope immutable: run ID, provider instance ID, workspace, permission profile, and capability ceiling.
3. Implement a registry keyed by provider instance and run; prohibit a global active thread.
4. Require every event to carry provider thread, native turn, process generation, and stable native identity before normalization.
5. Run `bun test packages/provider-runtime`.
6. Commit `feat(provider): define scoped provider runtime contracts`.

**Done when:** A deterministic provider fixture passes without importing orchestration, Convex, or daemon modules.

### Task A3: Make the reactor registry the only provider side-effect path

**Files:**

- Modify: `packages/orchestration/src/orchestration-engine.ts`
- Modify: `packages/orchestration/src/fake-provider-reactor.ts`
- Create: `packages/orchestration/src/reactor-registry.ts`
- Modify: `apps/daemon/src/kernel-daemon.ts`
- Create: `apps/daemon/src/provider-reactors.ts`
- Test: `packages/orchestration/src/orchestration-engine.integration.test.ts`
- Test: `apps/daemon/src/kernel-daemon.wiring.test.ts`

**Steps:**

1. Add a failing test proving daemon provider callbacks cannot call `appendEvent` directly.
2. Register provider start/resume/send/steer/interrupt/resolve/stop reactors by effect kind.
3. Route all results through lease-fenced internal commands with stable semantic IDs.
4. Reconcile running effects and provider sessions before the command source accepts new work.
5. Delete the direct catalog/Codex turn execution branches after equivalent reactors are green.
6. Run focused orchestration and daemon wiring tests, then commit `refactor(kernel): make providers durable reactors`.

### Gate G1 — Runtime Contract

- Fake and local runtime pass the same complete contract.
- Provider runtime has a reusable conformance suite.
- No daemon callback directly mutates run state or appends provider events.
- `bun run typecheck && bun run test` passes.

---

## Phase B — Complete the real Codex vertical slice

### Task B1: Pin Codex schemas and compatibility

**Files:**

- Create: `scripts/generate-codex-app-server-schema.ts`
- Create: `scripts/check-codex-app-server-schema.ts`
- Create: `scripts/check-codex-app-server-schema.test.ts`
- Modify: `packages/providers/codex-app-server/src/generated/`
- Modify: `packages/providers/codex-app-server/package.json`
- Modify: root `package.json`

**Steps:**

1. Add a failing drift test for missing files, changed output, or incompatible Codex version.
2. Generate both TypeScript and JSON schemas; record generator version and content hash.
3. Define minimum/current compatible versions and initialization capabilities.
4. Make ordinary CI validate committed metadata; protected CI may regenerate with the pinned binary.
5. Run `bun run codex:schema:check`; commit `build(codex): pin app-server protocol schemas`.

### Task B2: Replace the Codex transport with a supervised bidirectional peer

**Files:**

- Refactor: `packages/providers/codex-app-server/src/codex-transport.ts`
- Create: `packages/providers/codex-app-server/src/json-rpc-peer.ts`
- Create: `packages/providers/codex-app-server/src/process-supervisor.ts`
- Create: `packages/providers/codex-app-server/src/fixture-app-server.ts`
- Create: `packages/providers/codex-app-server/src/codex-transport.integration.test.ts`

**Steps:**

1. Test handshake ordering, request correlation, server requests, response transmission, notification backpressure, abort, timeout, malformed JSON, stderr bounds, process exit, and graceful close.
2. Replace input dropping with a bounded queue that applies backpressure or terminates with a typed overload failure.
3. Enforce `maxPendingRequests` before allocating a request ID.
4. Add `respond(id, result|error)` and keep server request IDs until the durable resolution is sent.
5. Supervise process generation and propagate typed `ProviderProcessLost`.
6. Filter the environment and keep credentials off argv and logs.
7. Run `bun test packages/providers/codex-app-server/src/codex-transport.integration.test.ts`; commit `feat(codex): supervise bidirectional app-server transport`.

### Task B3: Normalize the generated v2 event and request surface

**Files:**

- Refactor: `packages/providers/codex-app-server/src/normalize-event.ts`
- Expand: `packages/providers/codex-app-server/src/normalize-event.test.ts`
- Create: `packages/providers/codex-app-server/src/normalize-request.ts`
- Create: `packages/providers/codex-app-server/src/normalize-request.test.ts`

**Steps:**

1. Build a table from generated `ServerNotification` and `ServerRequest` discriminants.
2. Cover thread/turn lifecycle, item lifecycle, agent/plan deltas, commands, patches, approvals, user input, MCP, usage, rerouting, compaction, warnings, and safety events.
3. Preserve native thread/turn/item/request identity outside canonical payloads.
4. Map unknown methods to bounded local diagnostics including protocol version; never fabricate `activity.delta`.
5. Add compile-time exhaustiveness checks against the generated unions.
6. Run normalizer tests; commit `feat(codex): normalize the complete app-server surface`.

### Task B4: Implement the Codex driver, scoped sessions, and Relay tool bridge

**Files:**

- Create: `packages/providers/codex-app-server/src/codex-driver.ts`
- Refactor: `packages/providers/codex-app-server/src/codex-session-adapter.ts`
- Create: `packages/provider-runtime/src/relay-tool-bridge.ts`
- Create: `packages/provider-runtime/src/relay-tool-bridge.test.ts`
- Test: `packages/providers/codex-app-server/src/codex-session-adapter.integration.test.ts`

**Steps:**

1. Implement the Phase A provider contracts without mutable global thread state.
2. Persist thread identity before acknowledging session start.
3. Route approval, file-change approval, user input, and MCP elicitation through durable kernel commands; answer only after durable resolution.
4. Implement the Relay tool bridge with run/turn/correlation identity, capability-ceiling revalidation, duplicate-call receipts, bounded results, and cancellation.
5. Test two sessions with deliberately interleaved and late native events.
6. Run provider conformance; commit `feat(codex): add durable scoped provider sessions`.

### Task B5: Wire Codex into durable reactors and prove the real lifecycle

**Files:**

- Modify: `apps/daemon/src/provider-reactors.ts`
- Modify: `apps/daemon/src/kernel-daemon.ts`
- Create: `apps/daemon/src/codex-harness.e2e.test.ts`
- Create: `scripts/smoke-codex-harness.ts`
- Modify: root `package.json`

**Steps:**

1. Add a fake-transport E2E covering stream, steer, approval, deny, interrupt, resume, and terminal completion.
2. Kill the provider during request, streaming, tool execution, approval, and terminal delivery; assert resume or one accurate failure.
3. Kill the daemon after a durable effect and before acknowledgement; assert no duplicate tool or assistant event.
4. Add the opt-in real repository task under `RELAY_E2E_CODEX=1`.
5. Run the fake suite in CI and protected real smoke nightly/release.
6. Commit `test(codex): prove the durable Codex harness lifecycle`.

### Gate G2 — Real Durable Codex Turn

- One browser-originated kernel turn completes through Codex with no simulated output.
- All server requests are visible and answerable.
- Provider or daemon loss cannot route an event to the wrong run or duplicate an effect.
- Codex and deterministic provider pass the same provider/runtime lifecycle.

---

## Phase C — Canonical history, context, and artifacts

### Task C1: Project deterministic canonical history from events

**Files:**

- Expand: `packages/contracts/src/history.ts`
- Create: `packages/orchestration/src/projections/history-projection.ts`
- Create: `packages/orchestration/src/projections/history-projection.test.ts`
- Modify: `packages/local-store/src/database.ts`
- Create: `packages/local-store/src/history-store.ts`

**Steps:**

1. Test user input, assistant text, tool calls/results, approvals, steering, subagents, checkpoints, usage, errors, artifacts, and unresolved work.
2. Reduce ordered events into a deterministic history snapshot with event provenance.
3. Persist snapshot plus through-sequence and verify replay hash before replacing it.
4. Prove full replay equals snapshot-plus-suffix replay.
5. Commit `feat(history): derive provider-independent canonical history`.

### Task C2: Add a content-addressed local artifact store

**Files:**

- Create: `packages/contracts/src/artifacts.ts`
- Create: `packages/local-store/src/artifact-store.ts`
- Create: `packages/local-store/src/artifact-store.integration.test.ts`
- Modify: `packages/local-store/src/database.ts`

**Steps:**

1. Test atomic writes, deduplication, cursored reads, hash verification, media types, cancellation, partial-write cleanup, and restart.
2. Store large content under daemon home by hash; metadata belongs to the run and producing event.
3. Reject path traversal and never expose arbitrary filesystem paths as artifact IDs.
4. Publish only redacted previews, byte counts, hashes, and availability.
5. Commit `feat(store): add bounded content-addressed artifacts`.

### Task C3: Replace heuristic compaction with a semantic context planner

**Files:**

- Refactor: `packages/harness-runtime/src/context-manager.ts`
- Expand: `packages/harness-runtime/src/context-manager.test.ts`
- Create: `packages/harness-runtime/src/context-planner.ts`
- Create: `packages/harness-runtime/src/compaction-service.ts`
- Modify: `packages/contracts/src/history.ts`

**Steps:**

1. Add a 100-turn test preserving goal, constraints, decisions, paths, commands, test state, failures, approvals, tasks, and artifact/checkpoint references.
2. Separate deterministic selection from model-backed summarization.
3. Honor `maxTokens`, `compactToTokens`, and `preserveRecentTurns`; pin system/project instructions and unresolved work.
4. Persist immutable versioned compaction artifacts with source sequences and prompt/schema versions.
5. Return a report containing included/excluded IDs, token estimate, lineage, and artifact references.
6. Commit `feat(context): add semantic durable compaction`.

### Task C4: Wire context inspection, compact, export, and handoff preparation

**Files:**

- Modify: `apps/daemon/src/builtin-commands.ts`
- Modify: `apps/daemon/src/slash-commands.ts`
- Modify: `apps/web/src/context-inspector.tsx`
- Create: `apps/daemon/src/history-export.ts`
- Test: matching daemon/web tests

**Steps:**

1. Make `/context` report the exact planned provider input.
2. Make `/compact [instructions]` schedule a durable compaction effect.
3. Add pin/unpin commands and canonical history export.
4. Produce a provider-neutral handoff package without private reasoning or raw secrets.
5. Commit `feat(context): expose context control and export`.

---

## Phase D — Durable workspace, truthful tools, and technical sandbox

### Task D1: Complete workspace and checkpoint authority

**Files:**

- Refactor: `packages/workspace-runtime/src/workspace-manager.ts`
- Expand: `packages/workspace-runtime/src/workspace-manager.integration.test.ts`
- Refactor: `packages/workspace-runtime/src/checkpoint-manager.ts`
- Create: `packages/workspace-runtime/src/checkpoint-manager.integration.test.ts`
- Modify: `apps/daemon/src/worktrees.ts`
- Modify: checkpoint adapters under `apps/daemon/src/adapters/`

**Steps:**

1. Test real Git worktree create/reopen/move/missing/conflict/cleanup behavior.
2. Reconcile durable records against `git worktree list --porcelain` at startup.
3. Capture idempotent pre/post-turn hidden refs and restore without destroying later refs.
4. Inject crashes around Git ref creation and durable result commands.
5. Block the first turn until workspace, permission profile, provider session, and checkpoint baseline are durable.
6. Commit `feat(workspace): make Git state durable and reconcilable`.

### Task D2: Introduce SandboxExecutor and platform enforcement

**Files:**

- Create: `packages/workspace-runtime/src/sandbox/sandbox-executor.ts`
- Create: `packages/workspace-runtime/src/sandbox/linux-bwrap.ts`
- Create: `packages/workspace-runtime/src/sandbox/macos-seatbelt.ts`
- Create: `packages/workspace-runtime/src/sandbox/windows-policy.ts`
- Create: `packages/workspace-runtime/src/sandbox/sandbox.contract.test.ts`
- Modify: `packages/contracts/src/permissions.ts`

**Steps:**

1. Write the escape suite first: outside writes, daemon credentials, `.env`, symlink swaps, `/proc/*/environ`, inherited secrets, loopback/private network, DNS rebinding, and child-process cleanup.
2. Define one execution request/result contract with roots, temp dir, environment, network policy, resource limits, timeout, process group, and audit receipt.
3. Implement Linux and macOS enforcement; fail closed when required primitives are unavailable.
4. Keep Windows read-only by default until an enforceable adapter passes the same contract.
5. Commit `feat(sandbox): enforce persisted permission profiles`.

### Task D3: Replace scattered tool unions with one truthful registry

**Files:**

- Create: `apps/daemon/src/tools/tool-registry.ts`
- Create: `apps/daemon/src/tools/tool-registry.test.ts`
- Refactor: `apps/daemon/src/tool-executor.ts`
- Refactor: `apps/daemon/src/tool-descriptions.ts`
- Refactor: `apps/daemon/src/governed-tool-executor.ts`

**Steps:**

1. Define registry entries with versioned schemas, description, capability/risk classifier, profile availability, executor, timeout/output policy, renderer metadata, and hooks.
2. Add a contract test: no advertised tool without schema and executor; no executor without governance and sandbox requirements.
3. Derive provider tool definitions and UI metadata from the registry.
4. Remove `any`-based mutation used to inject skill bodies.
5. Commit `refactor(tools): centralize truthful tool contracts`.

### Task D4: Deliver the core coding tool set through SandboxExecutor

**Files:**

- Create/modify: `apps/daemon/src/tools/file-tools.ts`
- Create: `apps/daemon/src/tools/search-tools.ts`
- Create: `apps/daemon/src/tools/git-tools.ts`
- Create: `apps/daemon/src/tools/shell-tools.ts`
- Modify: `apps/daemon/src/tools.ts`
- Expand: corresponding tests

**Steps:**

1. Implement bounded line-numbered read, exact replacement, structured patch, create/write with conflict detection, content search, and file search.
2. Implement structured Git status/diff/log/stage/commit/branch operations.
3. Route foreground and background shell processes through the sandbox.
4. Spill oversized results to artifacts with cursored retrieval.
5. Run the permission matrix across every tool and profile.
6. Commit `feat(tools): add the governed coding tool core`.

### Task D5: Complete persistent processes and external tool services

**Files:**

- Refactor: `apps/daemon/src/background-shells.ts`
- Create: `apps/daemon/src/pty-manager.ts`
- Modify: `apps/daemon/src/mcp-client.ts`
- Modify: `apps/daemon/src/mcp-registry.ts`
- Create: `apps/daemon/src/lsp-service.ts`
- Add registry modules for web, image, elicitation, and todos

**Steps:**

1. Persist process IDs, output cursors, status, ownership, and cleanup policy.
2. Add PTY stdin/resize/reconnect and restart diagnostics.
3. Route MCP progress, cancellation, OAuth, and elicitation through canonical interactions.
4. Implement real web search/fetch adapters rather than delegation markers.
5. Add LSP definitions/references/symbols/hover/diagnostics/rename and image inspection only where a real executor is configured.
6. Commit `feat(tools): complete persistent and external tool services`.

### Task D6: Make governance, hooks, and permissions unbypassable

**Files:**

- Refactor: `apps/daemon/src/governed-tool-executor.ts`
- Modify: `apps/daemon/src/policy.ts`
- Modify: hook modules from the extensibility work
- Modify: `convex/audit_log.ts`
- Test: governance, hook, sandbox, and approval suites

**Steps:**

1. Route every Relay-owned action through registry → policy → approval → sandbox → audit.
2. Record requested/effective scope, policy version, actor, correlation, and resolution.
3. Run hooks in a narrower sandbox; hooks may annotate, narrow, or deny, never widen.
4. Prove denial prevents execution and stale approvals cannot authorize a new request.
5. Commit `feat(governance): enforce one action chokepoint`.

### Gate G3 — Canonical History + Safety

- The second turn uses relevant first-turn history.
- Semantic compaction preserves every pinned invariant.
- No Relay-owned process spawns outside `SandboxExecutor`.
- No tool is advertised without a real governed executor.
- Supported-platform escape suites pass; unsupported enforcement fails closed.

---

## Phase E — Projection convergence and browser cutover

### Task E1: Complete command inbox leases and outbox convergence

**Files:**

- Refactor: `apps/daemon/src/sync/convex-command-source.ts`
- Refactor: `apps/daemon/src/sync/convex-projection-sink.ts`
- Modify: `convex/commands/inbox.ts`
- Modify: `convex/projections/publish.ts`
- Create: daemon sync integration tests

**Steps:**

1. Test lease expiry, generation fencing, duplicate completion, malformed payloads, bounded batches, response loss, partial publish, stale snapshot, and restart.
2. Validate versioned command envelopes before local persistence.
3. Return durable highest contiguous sequence from Convex and acknowledge local outbox only to that cursor.
4. Add per-run ordering and fair batching without hot per-work-type pollers.
5. Commit `feat(sync): make command and projection transport converge`.

### Task E2: Finish Convex widening, ownership, migration, and bounded reads

**Files:**

- Modify: `convex/schema.ts`
- Modify: `convex/migrations.ts`
- Modify: `convex/auth_helpers.ts`
- Modify: projection, approval, subagent, conversation, event, audit, command, and checkpoint modules
- Add/expand: matching `*.convex.test.ts`

**Steps:**

1. Add exhaustive owner/project/machine/device tests for every public and device function.
2. Add missing indexed fields such as project ID to projection snapshots; remove in-memory JSON filtering.
3. Replace user-growing `.collect()`/broad scans with paginated indexed reads.
4. Implement dry-run, resumable v1 backfill with provenance and verification.
5. Deploy widen, then dual-write/backfill, then verification as separate operations; do not narrow.
6. Commit `feat(convex): complete kernel projection migration`.

### Task E3: Build the subscription-based client runtime

**Files:**

- Refactor: `packages/client-runtime/src/client-runtime.ts`
- Create: `packages/client-runtime/src/connection-state.ts`
- Create: `packages/client-runtime/src/run-cache.ts`
- Create: `packages/client-runtime/src/event-reducer.ts`
- Create: `packages/client-runtime/src/sync-supervisor.ts`
- Expand: `packages/client-runtime/src/client-runtime.test.ts`

**Steps:**

1. Test snapshot hydration, reactive continuation, gap recovery, overlap dedupe, stale snapshots, offline cache, reconnect backoff, auth refresh, and run switching.
2. Separate connection state from data freshness.
3. Generate stable command IDs before network submission and retry with the same ID.
4. Reduce canonical messages, activity, approvals, usage, checkpoints, artifacts, tasks, and diagnostics.
5. Commit `feat(client): add resumable reactive run state`.

### Task E4: Cut the React workbench to canonical projections

**Files:**

- Create: `apps/web/src/runtime/relay-runtime-provider.tsx`
- Create: `apps/web/src/runtime/use-run.ts`
- Create: `apps/web/src/runtime/use-run-commands.ts`
- Modify: `apps/web/src/run-data.ts`
- Modify: `apps/web/src/thread-view.tsx`
- Modify: run list, message, activity, approval, checkpoint, artifact, subagent, and inspector components
- Create: `apps/web/src/thread-view.runtime.test.tsx`

**Steps:**

1. Render a complete run from fake client-runtime state with no direct Convex workflow references.
2. Migrate messages/activity first, then approvals/checkpoints/usage/artifacts/tasks/MCP/Git.
3. Derive Needs You from canonical pending interactions.
4. Surface stale/offline/gap states and exact effective sandbox/provider/workspace data.
5. Commit `refactor(web): render kernel projections through client runtime`.

### Task E5: Make shadow mode side-effect-safe and prove parity

**Files:**

- Refactor: `packages/orchestration/src/shadow-runner.ts`
- Create: `apps/daemon/src/shadow/shadow-runtime.ts`
- Create: `apps/daemon/src/shadow/projection-comparator.ts`
- Create: `apps/daemon/src/shadow/shadow-runtime.e2e.test.ts`
- Modify: `apps/daemon/src/index.ts`

**Steps:**

1. Prove only legacy performs side effects while kernel consumes recorded inputs with no-op reactors.
2. Normalize IDs/timestamps and compare text, activity order, approvals, usage, checkpoints, terminal status, completion, and redaction.
3. Store structured redacted mismatch artifacts.
4. Run a soak window with zero state-machine or terminal divergence.
5. Commit `test(cutover): prove side-effect-safe shadow parity`.

### Gate G4 — Projection Parity

- Kernel runs render entirely from snapshot plus ordered projection events.
- Refresh/offline/reconnect cannot lose or duplicate visible state.
- Shadow mode never executes a second side effect.
- Parity artifacts show no blocking divergence for the soak window.

---

## Phase F — Orchestrated workflows and real parallel agents

### Task F1: Replace legacy worker ownership with durable workflow effects

**Files:**

- Refactor: `packages/orchestration/src/workflows.ts`
- Modify: daemon command, Git, checkpoint, comparison, subagent, MCP, plan, and review workers
- Create: `apps/daemon/src/kernel-workflows.e2e.test.ts`

**Steps:**

1. Write an E2E that drives every workflow through command inbox and canonical projections.
2. Keep proven execution logic behind reactor adapters while removing independent claims and direct status mutations.
3. Disable every 200 ms worker loop in kernel mode.
4. Prove same-run mutations serialize while permitted read-only work proceeds concurrently.
5. Commit `refactor(workflows): move all execution behind orchestration`.

### Task F2: Add the durable task-graph scheduler

**Files:**

- Create: `packages/contracts/src/tasks.ts`
- Create: `packages/orchestration/src/task-graph.ts`
- Create: `packages/orchestration/src/task-scheduler.ts`
- Create: task graph and scheduler tests
- Modify: `packages/local-store/src/database.ts`

**Steps:**

1. Define task identity, parent, role, objective, artifact contract, dependencies, state, capability ceiling, context budget, workspace mode, model/provider, lease, and attempt policy.
2. Test DAG validation, deterministic frontier selection, limits, retry, cancellation, and restart.
3. Persist tasks and canonical task events.
4. Enforce machine, provider, repository, and per-parent concurrency limits.
5. Commit `feat(tasks): add durable parallel task scheduling`.

### Task F3: Implement parent-child communication and result integration

**Files:**

- Create: `packages/orchestration/src/task-messages.ts`
- Refactor: `apps/daemon/src/adapters/subagent-adapter.ts`
- Modify: `apps/daemon/src/worktrees.ts`
- Create: task integration tests

**Steps:**

1. Add follow-up, progress, cancel, failure, and typed terminal-result events.
2. Construct child context intentionally with a narrowed capability ceiling.
3. Persist child workspace before execution and capture result as patch/checkpoint artifact.
4. Validate patch applicability; support conflict reporting, rejection, and partial selection.
5. Commit `feat(tasks): integrate isolated child results`.

### Task F4: Implement review jury, plan, and elicitation workflows

**Files:**

- Create: `packages/orchestration/src/workflows/review-jury.ts`
- Create: `packages/orchestration/src/workflows/plan.ts`
- Create: `packages/orchestration/src/workflows/elicitation.ts`
- Modify: `convex/diff_comments.ts`
- Modify: relevant web panels

**Steps:**

1. Run reviewer and security reviewer against one immutable artifact with read-only fresh contexts.
2. Normalize findings to severity, location, evidence, recommendation, reviewer, disposition, and dedupe key.
3. Make Address Findings a separate traceable child task.
4. Move plan approval and MCP/provider questions to canonical pending interactions.
5. Commit `feat(workflows): add review and human-decision workflows`.

### Gate G5 — Competitive Floor

- Four independent runs can execute concurrently under a configured limit.
- A parent delegates three tasks in parallel and selectively integrates results.
- No workflow changes run state outside orchestration.
- Kernel mode has no active per-work-type polling loops.
- The deterministic competitive acceptance path passes through browser, Convex, daemon, tools, and worktrees.

---

## Phase G — Stabilize extensibility on kernel APIs

### Task G1: Define a versioned extension manifest and compatibility contract

**Files:**

- Create: `packages/contracts/src/extensions.ts`
- Create: `apps/daemon/src/extensions/manifest.ts`
- Create: `apps/daemon/src/extensions/registry.ts`
- Create: extension contract tests

Manifest contributions include skills, commands, tools, hooks, providers, context contributors, approval classifiers, artifact renderers, web panels, roles, and workflow templates. Test version compatibility, trust, deterministic resolution, conflicts, revocation, and historical readability.

### Task G2: Port existing extensibility to governed kernel seams

**Files:**

- Refactor: skills, slash commands, trust, hooks, todo, MCP, background shell, and model-directory modules
- Modify: tool registry, context planner, workflow registry, and client projections

Remove dual legacy/kernel implementations. Executable changes require restart; safe metadata may refresh. Project extensions load only after trust and cannot exceed host permissions.

### Task G3: Prove an external sample extension

Create a fixture package that adds one skill, one command, one tool, one hook, one renderer, and one workflow role without modifying Relay core. Test install, upgrade, conflict, revoke, uninstall, and an old run referencing the removed version.

**Phase commit series:** `feat(extensions): add versioned governed extension APIs`.

---

## Phase H — Reliability, security, observability, and operations

### Task H1: Build the deterministic kill-point matrix

**Files:**

- Create: `apps/daemon/src/reliability/kill-points.ts`
- Create: `apps/daemon/src/reliability/crash-recovery.e2e.test.ts`
- Create: `scripts/run-crash-matrix.ts`
- Modify: CI workflows

Cover remote claim, local persist, receipt check, event append, effect claim, provider start/thread/stream/approval, sandbox command, checkpoint ref, outbox publish/ack, and shutdown. Every case must converge without duplicate effects, sequence gaps, lost approvals, or permanent leases.

### Task H2: Implement retention, compaction, and storage-pressure behavior

**Files:**

- Create: `packages/local-store/src/retention.ts`
- Create: `packages/local-store/src/compaction.ts`
- Create: `apps/daemon/src/storage-pressure.ts`
- Add integration tests

Define policy by record class. Verify replay hashes before pruning. Pause new mutation before disk exhaustion. Never delete active-run recovery state or the only artifact/checkpoint reference.

### Task H3: Replace observability scaffolds with joined, redacted operations

**Files:**

- Refactor: `packages/local-store/src/observability.ts`
- Create: `apps/daemon/src/observability/logger.ts`
- Create: `apps/daemon/src/observability/metrics.ts`
- Create: `apps/daemon/src/observability/health.ts`
- Create: `apps/daemon/src/diagnostics.ts`
- Modify: `apps/daemon/src/cli.ts`

Implement rotating NDJSON, stable correlation/causation, bounded metrics without high-cardinality labels, subsystem health, optional OTLP, `relay doctor`, and a per-run replay view. Diagnostic fixtures must contain no secrets or raw prompts.

### Task H4: Close the threat model, credentials, authorization, and audit

**Files:**

- Create: `docs/security/threat-model.md`
- Create: `docs/security/security-invariants.md`
- Create: `apps/daemon/src/secret-store.ts`
- Modify: device credential/auth files and Convex auth/audit modules
- Create: authorization and hostile-input suites

Use enforceable invariants for every trust boundary. Add OS secret storage/fail-safe fallback, token rotation/revocation, complete actor-resource authorization, append-only audit, malicious provider/MCP inputs, and the sandbox escape corpus.

### Task H5: Implement process supervision, backup, restore, and upgrades

**Files:**

- Refactor: `packages/local-store/src/supervisor.ts`
- Create: `apps/daemon/src/backup.ts`
- Create: `apps/daemon/src/version-compatibility.ts`
- Create: `apps/daemon/src/updater.ts`
- Create/modify: service installer and release scripts
- Create: operations documentation

Replace `process.exit()` and backup stubs with testable dependencies. Support graceful drain, lease release, restart backoff, startup reconciliation, consistent SQLite backup, checksummed restore, staged signed upgrades, health-checked rollback, and launchd/systemd/Windows service installation.

### Task H6: Add the production security gate

Create `scripts/security-gate.ts` covering authz, traversal, symlink races, command injection, malformed JSON-RPC, oversized data, replay/reorder, revoked tokens, hostile MCP/Git hooks, secret echoes, dependency audit, and release checksums. Release requires zero unresolved critical/high findings.

### Gate G6 — Operational Readiness

- Full kill matrix, sandbox suite, authorization matrix, and security gate pass.
- `relay doctor`, backup/restore, upgrade rollback, and supervisor are exercised against compiled output.
- Joined traces explain browser → Convex → daemon → provider → tool → checkpoint → projection.
- Storage pressure degrades safely instead of corrupting state.

---

## Phase I — Evaluation, production acceptance, and kernel cutover

### Task I1: Build the harness evaluation and load suites

**Files:**

- Create: `scripts/eval-harness.ts`
- Create: `scripts/load-harness.ts`
- Create: `scripts/load-convex-projections.ts`
- Create: `scripts/load-client-runtime.ts`
- Create: `docs/operations/slo.md`

Measure navigation, precise edits, iterative repair, context retention, refusal recovery, crash recovery, worktree isolation, task decomposition, review quality, latency, tokens, tool correctness, and sandbox escapes. Store model/provider/prompt/tool versions and artifact hashes.

### Task I2: Establish and meet measured SLOs

Initial budgets:

- local command acceptance p95 < 500 ms while online;
- first visible activity p95 < 2 s excluding provider queue;
- 1,000-event catch-up p95 < 2 s;
- restart recovery p95 < 15 s;
- zero sequence gaps and duplicate effects;
- no 200 ms idle polling;
- bounded queue, memory, event, and artifact growth.

Capture baseline first. Optimize only measured bottlenecks and add a regression test for every optimization.

### Task I3: Run the OS, provider, and compiled-artifact conformance matrix

**Files:**

- Create: `scripts/run-conformance-matrix.ts`
- Modify: CI/release workflows
- Create: `docs/operations/support-matrix.md`

Run fake everywhere and protected Codex where credentials exist. Verify install, schema assets, migrations, SQLite, sandbox readiness, sleep/network recovery, doctor, backup, upgrade, shutdown, and uninstall on Linux/macOS/Windows targets. Do not claim support until the whole row is green.

### Task I4: Automate the production acceptance scenario

**Files:**

- Create: `apps/daemon/src/production-acceptance.e2e.test.ts`
- Create: `apps/web/e2e/production-acceptance.e2e-spec.ts`
- Create: `docs/operations/production-readiness-checklist.md`
- Create: `docs/operations/incident-runbook.md`

Automate the 17-step scenario from the competitive roadmap: paired browser, two runs, iterative failed-test correction, steering, allow/deny, checkpoints, provider and daemon kills, stale-cursor refresh, three parallel children, selective integration, fork/alternate solution, comparison, and redacted export.

### Task I5: Canary kernel default

**Files:**

- Modify: `apps/daemon/src/kernel-cutover.ts`
- Modify: `apps/daemon/src/runtime-mode.ts`
- Modify: `apps/daemon/src/index.ts`
- Create: `apps/daemon/src/kernel-default.test.ts`

Replace hardcoded simulated gates with recorded evidence. Roll out developer → opt-in Codex → shadow soak → canary → default with emergency legacy flag. Any stop-the-line invariant automatically reverts the machine.

### Task I6: Narrow schemas and remove legacy only after the release window

**Files:**

- Modify: Convex schema/read/write modules
- Delete after replacement proof: `agent-loop.ts` and legacy per-work-type workers
- Remove: raw-loop imports and runtime-mode flag
- Update: ADR/status/runbook evidence

Preconditions:

- kernel default for one real release window;
- zero required legacy activations;
- verified backup and rollback rehearsal;
- all cursors current and migrations verified;
- production acceptance and security gates green.

Deploy exclusive kernel reads/writes before schema narrowing. Narrow in a later release. Commit `refactor(kernel): complete the legacy runtime removal`.

### Gate G7 — Kernel Default

- Kernel is default on every claimed-supported platform.
- Competitive acceptance, recovery, security, and conformance matrices pass.
- One release window completes with no required legacy activation.
- Legacy deletion and schema narrowing have recorded rollback evidence.

---

## Phase J — Build the Relay-specific edge

This phase begins only after G7. It should not delay safety or kernel cutover.

### Task J1: Agent Time Machine

Reconstruct any canonical sequence, restore safely, fork by default, compare workspace/context/usage/approvals/outcome, and preserve provenance. Build on event replay, checkpoints, artifacts, and client-runtime rather than provider transcripts.

### Task J2: Visual parallel task graph

Project task dependencies, state, provider/model, budget, worktree, progress, and attention. Allow reprioritize/cancel, inspect child transcripts/artifacts, select integration results, and surface conflicts before merge.

### Task J3: Provider-independent handoff

Export a canonical context package and start a different conformant provider against the same run or fork. Preserve receipts, artifacts, decisions, and unresolved tasks; never expose provider-private reasoning.

### Task J4: Unified operator inbox

Unify approvals, MCP/provider questions, merge conflicts, plan review, failed recovery, budget exhaustion, trust, extension changes, and ambiguous tasks. Each item needs a resumable deep link and one clear action.

### Task J5: Deterministic replay and comparison

Compare provider/model/prompt/tool/policy variants and locate the first divergent decision or tool result. Promote successful runs into versioned evaluation fixtures.

### Gate G8 — Relay Edge

- Users can rewind, fork, compare, hand off, and selectively integrate.
- Parallel execution remains understandable and controllable from the browser.
- Every Needs You state is actionable from one inbox.
- Relay's durable remote supervision is a product advantage, not hidden infrastructure.

---

## 3. Verification policy for every task

Each task must:

1. Write the observable failing test first.
2. Run it and record the expected failure.
3. Implement the minimum complete behavior.
4. Run focused tests and typecheck for affected packages.
5. Cover malformed input and bounded payloads.
6. Cover duplicate/idempotency behavior.
7. Cover cancellation/timeout and stale generations.
8. Cover restart/replay for durable state.
9. Cover permission, redaction, and diagnostics.
10. Commit only task-scoped files.

Phase gate verification:

```bash
bun run typecheck
bun run test
bun run build
bun run bundle:check
git diff --check
```

Run additional suites when applicable:

```bash
bun run scripts/run-crash-matrix.ts --profile=pr
bun run scripts/security-gate.ts
bun run scripts/run-conformance-matrix.ts
RELAY_E2E_CODEX=1 bun run test:e2e:harness
```

Do not call a phase complete based only on unit tests for scaffolding. Its active daemon/browser path and phase gate must be green.

---

## 4. Recommended implementation batches

Keep batches reviewable:

1. **Batch 1:** A1-A3 — shared contracts and reactor-only provider boundary.
2. **Batch 2:** B1-B3 — Codex protocol, transport, and normalization.
3. **Batch 3:** B4-B5 — scoped sessions, tool bridge, durable real turn.
4. **Batch 4:** C1-C4 — history, artifacts, context, controls.
5. **Batch 5:** D1-D2 — workspace/checkpoint authority and sandbox.
6. **Batch 6:** D3-D6 — truthful tools, persistent services, governance.
7. **Batch 7:** E1-E2 — projection convergence and Convex migration.
8. **Batch 8:** E3-E5 — client/web cutover and shadow parity.
9. **Batch 9:** F1-F4 — workflows, task graph, parallel agents, review.
10. **Batch 10:** G1-G3 — stable extension APIs.
11. **Batch 11:** H1-H3 — crash/storage/observability.
12. **Batch 12:** H4-H6 — security, credentials, operations.
13. **Batch 13:** I1-I4 — evaluation, conformance, production acceptance.
14. **Batch 14:** I5 — canary and kernel default.
15. **Batch 15:** I6 — separate post-window narrowing and deletion.
16. **Post-default:** J1-J5 — Relay edge.

After each batch:

- run a standards review and a spec/correctness review;
- resolve every high-severity finding before commit;
- append evidence and status to `docs/plan/relay-competitive-harness-implementation-plan.md`;
- preserve unrelated dirty workspace changes.

---

## 5. Final definition of done

Relay is over the competitive threshold when:

- it completes real iterative repository work through a conformant provider;
- its tools are truthful, complete, governed, and sandboxed;
- its history and context survive long sessions and provider changes;
- daemon/provider/network crashes converge without duplicated work;
- multiple isolated agents execute and integrate under operator control;
- the browser exactly resumes local canonical authority;
- extension authors use stable governed APIs;
- supported platforms pass installation, sandbox, recovery, upgrade, and uninstall;
- the kernel is the default and the legacy loop is gone;
- Relay's time travel, visual task graph, operator inbox, and provider handoff make its remote supervision meaningfully better than a terminal-only harness.

## Execution handoff

Start with Phase A in a dedicated worktree. Do not begin browser cutover, workflow migration, or additional provider work before Gate G1 passes. Use `superpowers:executing-plans`, implement one task at a time, and stop for review at every gate.
