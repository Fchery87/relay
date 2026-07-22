# Relay Competitive Harness Implementation Plan

Status: in progress
Date: 2026-07-18
Scope: turn Relay's current codebase into a competitive, durable, secure agentic coding harness
Primary destination: make Relay the best remote, supervised, replayable coding-agent workbench rather than another terminal-only clone

## Implementation progress

### 2026-07-18 — Increment 1, batch 1

Completed:

- removed synthetic assistant output from the local runtime;
- routed run creation and provider events through typed orchestration commands;
- restored `reduceRun(state, event)` as the sole run-status transition function;
- made run creation atomic across snapshot, canonical event, outbox row, and command receipt;
- returned duplicate command receipts before re-running state validation;
- protected snapshot persistence with the loaded stream version;
- replaced the broken per-run drain path with fair FIFO scheduling and a global active-run limit;
- implemented live ordered observation with cancellation, commit notifications, cursor verification, and cross-connection SQLite rechecks;
- added characterization and integration coverage for truthful turns, reducer-owned provider events, atomic creation, duplicate terminal commands, FIFO draining, live observation, cancellation, and restart recovery.

### 2026-07-18 — Increment 1, batch 2

Completed:

- persisted immutable, versioned command receipts and returned the canonical
  `turnId` from storage on first delivery and redelivery;
- carried `turnId` and `providerInstanceId` through canonical event drafts,
  SQLite rows, observation, reducer state, and restart recovery;
- added versioned runtime validation for snapshot, event payload, command, and
  receipt boundaries, with legacy record compatibility and fail-closed reads;
- made permission, workspace, provider session, active turn, checkpoint, and
  reducer payload metadata round-trip in complete snapshots;
- inserted durable effect intents in the same transaction as events,
  projections, snapshots, and receipts;
- moved snapshot loading, pure deciding/reducing, and optimistic-version
  validation inside that same SQLite transaction;
- added leased effect claiming, attempt counts, retry classes, terminal
  completion/failure state, lease renewal, stable idempotency keys, and
  idempotent internal result commands;
- split reactor execution from recovery so a reclaimed lease reconciles by
  idempotency key and never blindly invokes the original side effect twice;
- fenced every internal result write against the live effect lease inside its
  SQLite transaction, and gave provider results stable semantic identities so
  partial batches recover without positional command-ID collisions;
- enforced durable effect insertion order, fail-closed expiry for non-retryable
  effects, terminal failure commands after retry exhaustion, turn-scoped
  provider result validation, one active turn per run, and durable per-run
  turn-ID uniqueness;
- serialized overlapping drain requests as successor passes without losing
  effects queued during promise settlement;
- replaced the stub dispatcher with a reactor registry and a deterministic fake
  provider reactor used only by tests;
- proved that 100 concurrent duplicate turn deliveries persist one receipt, one
  `turn.started`, and one provider effect;
- proved that a provider effect survives runtime restart, completes through
  canonical internal commands, and is not executed by a second drain.

Next batch:

- wire the first real Codex provider reactor through the daemon composition.

### 2026-07-18 — Increment 1, batch 3

Completed:

- bounded durable reactor execution by the configured global active-run limit
  while claiming only one FIFO head per run;
- proved that twenty independent provider effects execute with no more than four
  active reactors and that seeded, shuffled cross-run commands retain exact
  per-run submission order;
- persisted retry eligibility, failure category, last error, and terminal
  failure time for every durable effect;
- added deterministic exponential retry backoff with a cap and stable jitter,
  explicit rate-limit delays, terminal and approval-required classification,
  an injectable clock for sleep-free recovery tests, and a due-time scheduler
  that rearms delayed retries without a polling loop;
- emitted bounded, contextual terminal failure results after retry exhaustion
  instead of exposing an unclassified provider exception;
- added an idempotent corruption quarantine transaction that records one
  durable affected-run diagnostic, emits a canonical `run.failed` event for a
  live run, repairs its snapshot to a safe terminal state, and survives reopen;
- applied corruption quarantine consistently when snapshot, event, command
  receipt, or command-processing reads encounter an invalid persisted record;
- made external and internal command/run-state policies explicit and
  table-tested across every command and every run status;
- attached steer events to the active turn and rejected steer commands without
  one;
- persisted provider steer, interrupt, approval-resolution, session-stop, and
  checkpoint-restore effects; interrupt and terminal transitions now
  atomically fence superseded live effects before cleanup work is claimed;
- ignored stale provider output for an inactive turn and every provider event
  received after a run reaches a terminal state;
- introduced strict canonical `replayRun()` validation for run identity,
  sequence continuity, and stream-version continuity, plus genesis replay that
  reconstructs creation metadata without consulting a persisted snapshot;
- proved that persisted canonical history reconstructs the exact durable
  snapshot after close/reopen and that retries wake without an external polling
  drain.
- treated successful provider-send execution as durable adapter acceptance so
  queued live steering can execute while terminal turn notifications continue
  to arrive independently;
- required every turn-scoped provider event to carry an exact active `turnId`
  at both the runtime schema boundary and the decider, using one shared scope
  policy that includes turn genesis and checkpoint capture;
- validated canonical event membership plus required and optional payload and
  envelope fields before scheduling, so malformed live input is rejected
  without being misclassified as persisted-store corruption;
- delayed `checkpoint.restored` until the checkpoint reactor returns the real
  commit instead of emitting speculative success with an empty commit;
- archived a corrupt event and its untrusted suffix, preserved the validated
  prefix, and replaced the suffix with one replayable canonical failure so
  subsequent reads no longer remain permanently poisoned;
- made retry recovery consider both pending due times and running lease expiry,
  and made runtime shutdown fence admission, abort active reactors, and await
  their settlement before closing SQLite.
- routed successful effects back through fenced internal result commands,
  correlated checkpoint and workspace results with their intents, and kept
  approval gates pending until provider resolution is durably accepted;
- persisted the pending approval identity, rejected stale external and provider
  resolutions, and cleared abandoned gates when their turn terminates;
- carried Relay turn identity through the real Codex and catalog-provider
  daemon paths, serialized Codex notification appends, preserved and fenced on
  native Codex thread/turn identity to reject late cross-run notifications, and
  waited for a durable terminal notification instead of treating `turn/start`
  acceptance as completion.

Next batch:

- complete the shared `HarnessRuntime` conformance suite so the deterministic
  fake and local durable runtime execute identical lifecycle cases;
- wire the first real Codex provider reactor through the daemon composition,
  including schema generation and supervised app-server transport;
- extend deterministic reliability coverage from transaction rollback and
  close/reopen replay to the full lifecycle kill-point matrix tracked by
  Ticket 14.

## Authority and relationship to existing plans

This document is the current program-level implementation order for the findings from the 2026-07-18 code audit.

It preserves the accepted decisions in:

- `docs/adr/0001-adapter-first-local-harness.md`
- `docs/adr/0002-local-authority-convex-projections.md`
- `docs/adr/0003-canonical-command-event-model.md`
- `.scratch/harness-kernel/PRD.md`

Where sequencing conflicts, this plan supersedes:

- `docs/plans/2026-07-18-relay-competitive-upgrade.md`
- the legacy-runtime sequencing in `docs/plans/2026-07-18-harness-extensibility.md`

Those documents remain useful as implementation research and detailed task inventories. They must not be used to add new product behavior to the legacy runtime. New capabilities land behind the kernel contracts and are projected to the browser from the kernel path.

The active self-hosted recovery and cutover plan at `docs/plans/2026-07-22-self-hosted-convex-recovery-implementation-plan.md` is now the comprehensive acceptance inventory for reliability, migration, security, and rollout. The earlier production-readiness plan remains historical implementation context. This document narrows the active inventory into the shortest dependency-ordered route to a competitive product.

## Executive decision

Relay will not win by copying every Claude Code, Codex, OpenCode, or Pi feature into the current legacy daemon.

Relay will win by completing one authoritative vertical system:

```text
browser command
  -> authenticated Convex inbox
  -> durable local receipt
  -> serialized run reducer
  -> provider session
  -> governed and sandboxed tools
  -> canonical events and artifacts
  -> transactional projection outbox
  -> resumable browser view
  -> crash recovery and replay
```

The first competitive milestone is not "more features." It is a truthful, iterative coding turn that can read, edit, test, recover from failure, survive a daemon restart, and render accurately in the browser.

## Destination

The program is complete when the kernel is Relay's default runtime and a user can:

1. Start two isolated runs against the same repository.
2. Give one run a multi-step coding task that requires search, read, edit, test, failure diagnosis, correction, and retest.
3. Watch ordered activity and assistant output stream live in the browser.
4. Steer, stop, approve, deny, and answer provider or MCP requests without losing the turn.
5. Kill the daemon or provider at any lifecycle boundary, restart it, and continue without a duplicated side effect or stranded run.
6. Refresh or reconnect the browser from a sequence cursor without gaps or duplicates.
7. Inspect the exact effective permission profile, context summary, tool receipts, usage, workspace, checkpoint, and provider session for the run.
8. Delegate independent work to parallel agents in isolated worktrees and review a deterministic integration result.
9. Fork a prior checkpoint into an alternate run and compare the two outcomes.
10. Add tools, hooks, skills, provider adapters, and UI renderers through a stable extension contract.

## Product position

Relay's competitive identity should be:

> A remote, durable, supervised workbench for running coding agents safely across machines, repositories, providers, and parallel worktrees.

The product moat is the combination of:

- local execution authority;
- browser-based remote operation;
- durable event replay;
- isolated worktrees and per-turn checkpoints;
- human approval and audit;
- parallel task graphs;
- provider-independent canonical history;
- rewind, fork, compare, and restore.

Terminal, IDE, and headless surfaces are important clients of this system. They are not separate runtimes.

## Non-negotiable engineering rules

### One authority

Only the orchestration reducer may change canonical run status. Providers, React, Convex gateways, workers, and adapters emit commands or events.

### Capability truth

A capability may be advertised to the model or user only if it:

- executes for real;
- returns its real result;
- is governed and sandboxed;
- emits canonical lifecycle events;
- survives process restart where applicable;
- has an end-to-end test.

Delegation markers, simulated replies, no-op concurrency limits, stub reactors, and successful placeholder returns violate this rule.

### No new legacy features

The legacy runtime receives only:

- migration instrumentation;
- compatibility fixes required for shadow comparison;
- critical correctness or security fixes needed during the cutover window.

Skills, hooks, tools, providers, orchestration, and UI features must be implemented through reusable kernel-facing seams.

### Sandbox and approval are separate

Approval authorizes an action. The sandbox limits what an authorized action can technically do. Neither substitutes for the other.

### Durable before visible

An event is projected only after it is durable locally. A browser acknowledgement never advances local state unless the corresponding contiguous projection is confirmed.

### No second provider before conformance

The deterministic fake and Codex app-server are the initial adapter pair. A second real provider is admitted only after the provider conformance suite passes against Codex without adapter-specific exceptions in canonical contracts.

## Baseline findings this plan must close

The implementation must explicitly eliminate these current conditions:

- `RELAY_RUNTIME_MODE` defaults to `legacy`.
- The web reads `legacyRunData`.
- the production model router returns the old one-shot `ModelProvider`;
- conversation history is claimed but not used by the active turn;
- `LocalHarnessRuntime.sendTurn()` emits a simulated assistant reply;
- production `observe()` is not a live durable subscription;
- orchestration effects and workflows are stubbed;
- the concurrency limit does not enforce a limit;
- the daemon uses independent hot polling loops and one global top-level turn flag;
- Codex server-to-client requests are not answered;
- Codex input may be silently dropped under load;
- one Codex active thread is shared instead of mapping runs to durable sessions;
- Codex turns are marked complete without waiting for a terminal provider event;
- web search and fetch return delegation markers rather than results;
- tool descriptions advertise unavailable tools;
- background shell infrastructure is not connected to production;
- host shell execution bypasses the workspace sandbox;
- the sandbox escape suite contains unimplemented cases;
- the local outbox is not the authoritative projection publisher;
- observability does not provide joined end-to-end traces;
- acceptance tests do not prove a real provider can complete a coding task.

## Program gates

Every phase ends at a gate. Work beyond a gate may be prototyped, but it may not be enabled by default until the gate passes.

| Gate | Outcome | Release consequence |
|---|---|---|
| Truthful Kernel | No simulated or paper capability remains in the kernel path | Kernel may enter shadow mode |
| Durable Turn | A multi-step turn survives daemon and provider restarts | Kernel may run opt-in canaries |
| Safety | Supported permission profiles are technically enforced | Full-access and broader tools may be exposed |
| Projection Parity | Kernel browser state matches the canonical local stream | Browser read cutover may begin |
| Competitive Floor | Real coding-task and concurrency suites pass | Kernel may become default |
| Extensible Platform | Stable lifecycle and tool APIs pass compatibility tests | Third-party extensions may be supported |
| Relay Edge | Fork/replay/task-graph workflows pass product acceptance | Relay can claim differentiated capability |

## Delivery topology

The work is organized into nine increments. Increments are dependency ordered; tracks inside an increment may run in parallel only when they do not share a state transition owner or composition root.

Estimated total effort is approximately 18-26 engineering weeks. With three engineers and disciplined ownership boundaries, the competitive floor is plausibly 10-14 calendar weeks. The differentiated features continue after that floor.

Recommended ownership boundaries:

| Track | Primary code |
|---|---|
| Kernel and state | `packages/harness-runtime`, `packages/orchestration`, `packages/local-store` |
| Providers | `packages/providers/*` |
| Workspace safety and tools | `packages/workspace-runtime`, daemon tool adapters |
| Sync and browser | daemon sync adapters, `convex/`, `packages/client-runtime`, `apps/web` |
| Evaluation and operations | acceptance suites, recovery harness, observability, packaging |

## Increment 0: Freeze the baseline and make failures executable

Effort: 3-5 engineering days
Depends on: none
Gate: none; this creates the evidence used by every later gate

### Objective

Turn every critical audit finding into a failing characterization or acceptance test before changing architecture.

### Work

#### Kernel truth characterizations

Add tests proving that:

- sending a turn produces no assistant content until a provider event arrives;
- appending a canonical event updates the snapshot through the reducer;
- `observe()` remains open and emits new events after its initial replay;
- two commands for the same run are strictly serialized;
- independent runs never exceed the configured concurrency limit;
- an emitted effect is durably claimed, executed once, and acknowledged;
- unsupported workflows fail before a command is accepted rather than after state mutation.

Primary files:

- `packages/harness-runtime/src/local-harness-runtime.integration.test.ts`
- `packages/orchestration/src/orchestration-engine.test.ts`
- `packages/local-store/src/event-store.test.ts`

#### Provider protocol characterizations

Add fixture-driven tests proving that:

- server-to-client JSON-RPC requests receive exactly one response;
- queue saturation applies backpressure or terminates explicitly, never drops silently;
- `turn/start` returning does not imply turn completion;
- two simultaneous runs cannot consume each other's provider events;
- process loss rejects or recovers pending requests deterministically;
- every generated Codex v2 event is either normalized or recorded as a bounded diagnostic.

Primary files:

- `packages/providers/codex-app-server/src/codex-transport.test.ts`
- `packages/providers/codex-app-server/src/codex-session-adapter.test.ts`
- `packages/providers/codex-app-server/src/normalize-event.test.ts`

#### Active-path characterizations

Add a repository-task test that fails on the current default path:

1. Model asks to read a fixture file.
2. Tool output reveals the required edit.
3. Model edits.
4. Test command fails.
5. Model reads the failure, corrects the edit, and retests.
6. Turn ends only after the test passes.

Add assertions that the second user turn receives the prior user message, assistant response, tool activity summary, and unresolved state.

#### Safety characterizations

Convert every sandbox `test.todo` into an active supported-platform test. Unsupported platforms must assert fail-closed behavior and a surfaced limitation.

Cover:

- `..` traversal;
- symlink escape;
- daemon credential reads;
- inherited secret environment variables;
- `/proc/*/environ`;
- writes outside the worktree and run temp directory;
- loopback, private network, and metadata-service access;
- child-process and indirect-shell bypasses.

### Deliverables

- New scripts:
  - `test:kernel:conformance`
  - `test:provider:conformance`
  - `test:recovery`
  - `test:sandbox`
  - `test:e2e:harness`
- A checked-in deterministic repository fixture for coding-task tests.
- A baseline results artifact containing pass/fail counts and latency percentiles.

### Exit criteria

- Every baseline finding is represented by an executable test or an explicitly documented unsupported-platform assertion.
- Timing-sensitive tests use condition-based waits and fake clocks where possible; fixed sleeps are removed.
- Existing user changes in the worktree are never required for the fixture suite.

## Increment 1: Make the local kernel authoritative

Effort: 2-3 engineering weeks
Depends on: Increment 0
Gate: Truthful Kernel

### Objective

Create one correct local state machine before connecting more providers, tools, or UI behavior.

### Work

#### Remove simulated runtime behavior

- Delete the generated `"Harness reply to:"` path.
- Make `sendTurn()` submit a command to the orchestration engine and return a durable receipt.
- Remove direct event appends that bypass the reducer.
- Make the fake provider a reactor used by tests, not behavior embedded in `LocalHarnessRuntime`.

#### Complete the transaction boundary

For every accepted command, one SQLite transaction must:

1. validate and reserve `commandId`;
2. load the current snapshot and stream version;
3. run the pure decider;
4. append canonical events;
5. reduce the snapshot;
6. enqueue effect intents;
7. enqueue projection rows;
8. complete the command receipt.

Redelivery returns the immutable receipt without repeating effects.

#### Persist complete snapshots

Fix snapshot serialization so restart count, creation time, permission profile, workspace, provider session, turn, checkpoint, and reducer payload round-trip exactly.

Validate event and snapshot payloads at runtime with versioned schemas. Invalid local records stop the affected run and produce a diagnostic; they do not corrupt later replay.

#### Implement live observation

`observe({ runId, afterSequence })` must:

- replay durable events after the cursor;
- subscribe to new commits;
- preserve sequence ordering;
- support cancellation;
- reconnect to SQLite polling or notifier state without gaps;
- never emit a duplicate sequence to one observer.

Use a store-level notifier with cursor verification. The fake and local runtimes must pass the same contract.

#### Replace stub effects with durable reactors

Define a reactor registry for:

- provider session start/resume/stop;
- provider turn send/steer/interrupt;
- workspace create/reconcile;
- checkpoint capture/restore;
- tool execution;
- projection publish;
- workflow child creation and completion.

Each effect has an idempotency key, lease, attempt count, retry class, and terminal result command. Reactors never mutate snapshots directly.

#### Implement real scheduling

- One FIFO command queue per run.
- One active command transition per run.
- Configurable global active-run semaphore.
- Fair scheduling across runs.
- Cancellation propagation.
- No recursive queue draining.
- No global `turnRunning` boolean in the kernel.

### Tests

- Reducer table tests for every command/state combination.
- 100 concurrent duplicate deliveries produce one receipt and one effect.
- 20 runs under a limit of four never exceed four active reactors.
- Randomized command ordering preserves per-run sequence.
- Kill after each transaction step; replay produces the expected snapshot.
- Observer reconnect from every sequence produces the same final projection.

### Exit criteria

- The fake runtime and local runtime pass one `HarnessRuntime` contract suite.
- No kernel path writes run status outside the reducer.
- No kernel method emits model or assistant content without an adapter event.
- No accepted command can be stranded without a completed receipt or reclaimable lease.
- Kernel shadow mode can run without invoking an incomplete workflow.

## Increment 2: Complete one real provider vertical slice

Effort: 2-3 engineering weeks
Depends on: Truthful Kernel
Gate: Durable Turn

### Objective

Make Codex app-server the first real provider that passes the complete run lifecycle through `HarnessRuntime`.

### Work

#### Pin and negotiate the protocol

- Regenerate and pin current app-server TypeScript and JSON schemas.
- Record the compatible Codex version range.
- Negotiate capabilities at initialization.
- Refuse incompatible versions with an actionable diagnostic.
- Maintain fixture compatibility tests for the minimum and current supported versions.

#### Repair transport semantics

- Enforce `maxPendingRequests`.
- Replace incoming-event dropping with bounded backpressure.
- Add a response API for every server-to-client request.
- Route approval, file-change approval, user-input, and MCP elicitation requests to kernel commands.
- Preserve request IDs until a response is durably sent.
- Supervise process exit, stderr, restart, and reconnect.
- Redact secrets from logs and keep credentials off argv.

#### Introduce a provider-session registry

Persist:

- Relay run ID;
- provider instance ID;
- provider thread ID;
- active turn ID;
- protocol version;
- last native event identity;
- resume token or restart metadata;
- effective sandbox profile;
- process generation.

The daemon may host many provider sessions. No global active thread is allowed.

#### Wait for terminal provider events

`startTurn()` starts a turn; it does not complete it. The adapter remains subscribed until exactly one native terminal state is normalized:

- completed;
- failed;
- interrupted;
- provider process lost and recovery exhausted.

Relay must not synthesize success after the request response.

#### Normalize the complete event surface

Use a table-driven normalizer for:

- thread/session lifecycle;
- turn lifecycle;
- agent text and plan deltas;
- command execution and terminal interaction;
- file changes and patches;
- approvals and server requests;
- MCP progress and elicitation;
- usage and model rerouting;
- compaction;
- subagent events;
- warnings, deprecations, and safety buffering.

Unknown events become bounded local diagnostics with provider version and method. They never masquerade as normal activity.

#### Wire daemon composition

- Provide Codex transport configuration from the actual daemon startup path.
- Replace the single adapter field with the session registry.
- Route every provider callback through internal engine commands.
- Remove immediate unsubscribe and synthetic completion.
- Resume recoverable sessions at daemon startup before accepting new turn commands.

### Tests

- Full fake-transport lifecycle: start, stream, approval, resolve, steer, interrupt, resume, complete.
- Two simultaneous runs with interleaved native events.
- Provider crash during request, text stream, tool execution, approval, and completion.
- Server request timeout and user cancellation.
- Opt-in real test: `RELAY_E2E_CODEX=1 bun run test:e2e:harness`.
- A real repository task requiring at least two tool iterations and one failed test correction.

### Exit criteria

- One browser-originated kernel turn completes through real Codex with no simulated events.
- Killing Codex mid-turn either resumes or ends in one accurate canonical failure.
- Killing the daemon mid-turn resumes without duplicate tool execution or assistant content.
- Every provider request awaiting a user decision is visible and answerable.
- The provider adapter passes the same lifecycle contract as the deterministic fake.

## Increment 3: Canonical history, context, and artifacts

Effort: 1.5-2.5 engineering weeks
Depends on: Durable Turn
Gate: part of Competitive Floor

### Objective

Make long-running sessions coherent, inspectable, exportable, and provider-independent.

### Work

#### Build canonical history from events

History includes:

- user inputs;
- assistant text;
- tool calls and bounded results;
- approvals and decisions;
- steering messages;
- subagent summaries;
- checkpoints and restores;
- usage;
- errors and unresolved tasks.

Provider-private reasoning remains provider-private. Canonical history must be sufficient to export, replay, switch providers, or rebuild a client view.

#### Make context construction a production service

The context manager must be called by every raw-model adapter and every workflow that creates a child context.

Inputs:

- system and project instructions;
- permission and environment invariants;
- canonical conversation;
- pinned user constraints and decisions;
- recent tool results;
- artifact references;
- unresolved tasks;
- context budget and provider limits.

Outputs:

- ordered context items;
- token estimate;
- included and excluded item IDs;
- compaction lineage;
- artifact references;
- a user-visible context report.

#### Implement semantic compaction

Compaction must use a model-backed structured summary, not a count of removed items.

The summary schema preserves:

- user goal and constraints;
- decisions and rationale;
- modified and inspected files;
- commands run and material results;
- current test/build state;
- failures and attempted fixes;
- pending approvals;
- unresolved tasks;
- exact artifact and checkpoint references.

Keep recent turns according to configuration. Honor `compactToTokens` and `preserveRecentTurns`. Compactions are immutable, versioned artifacts with lineage.

#### Spill oversized output to artifacts

Tool output beyond inline limits is stored locally as a content-addressed artifact. Events contain:

- bounded preview;
- byte count;
- media type;
- hash;
- artifact ID;
- retrieval cursor.

The model can request another page without rerunning the tool. Cloud projections expose only redacted previews and metadata.

#### Add context inspection and manual control

Implement real:

- `/context`;
- `/compact [instructions]`;
- context budget and usage display;
- pinned item controls;
- export of canonical history;
- model handoff preparation.

### Tests

- A 100-turn fixture retains all pinned invariants after repeated compactions.
- Decisions, file paths, test failures, and unresolved tasks survive compaction.
- Oversized output is retrievable by cursor and never duplicated in provider context.
- Context reports match the actual items sent.
- History replay yields an equivalent final snapshot.

### Exit criteria

- The second turn demonstrably knows relevant first-turn state.
- Long runs remain below the configured context threshold.
- Manual and automatic compaction are functional.
- A run can be exported without provider-native transcript data.

## Increment 4: One real tool runtime and sandbox boundary

Effort: 3-4 engineering weeks
Depends on: Truthful Kernel; may proceed alongside Increment 2 after kernel contracts stabilize
Gate: Safety

### Objective

Make every Relay-owned action truthful, useful, governable, and technically confined.

### Work

#### Create a tool registry

Replace scattered unions and description tables with a registry whose entries define:

- versioned input and output schema;
- model description;
- capability and risk classifier;
- permission-profile availability;
- sandbox requirements;
- timeout and output policy;
- executor;
- renderer metadata;
- lifecycle hooks.

The model tool catalog is derived from this registry. A description cannot exist without an executor and schema.

#### Deliver the competitive core tool set

Required:

- file read with offset, line numbers, and byte limits;
- exact string replacement;
- structured patch application;
- create/write with conflict detection;
- grep/content search;
- glob/file search;
- structured Git status, diff, log, stage, commit, and branch operations;
- foreground shell;
- persistent PTY with stdin, resize, and reconnect;
- background process start, output, status, and kill;
- todo/progress updates backed by canonical state;
- user question and structured elicitation;
- real web search and page fetch;
- image and screenshot inspection;
- LSP definitions, references, symbols, hover, diagnostics, and rename;
- MCP tool calls with progress, cancellation, OAuth, and elicitation.

Optional tools remain disabled until they pass the capability-truth rule.

#### Route all execution through `SandboxExecutor`

The executor owns:

- filesystem grants;
- read-only and writable roots;
- run temp directory;
- filtered environment;
- working directory;
- network mode and approved destinations;
- CPU, memory, process, output, and wall-clock limits;
- process group cleanup;
- symlink-safe path resolution;
- platform support detection;
- audit receipt.

Legacy `runCommand()` may become an adapter over this executor during migration. It may not spawn directly after cutover.

#### Make permission profiles technically accurate

`read-only`:

- no writes;
- no mutable Git;
- no external network unless separately granted;
- read tools only.

`workspace-write`:

- writes limited to worktree and run temp;
- network denied by default;
- explicit approval may widen a specific action.

`full-access`:

- broader host access only when the platform can represent and audit it;
- never implies silent credential projection;
- UI displays the actual effective boundary.

Unsupported enforcement fails closed. The UI and run record show why.

#### Harden file access

- Open relative to pre-opened directory handles where supported.
- Reject symlink and mount escapes.
- Revalidate before write.
- Keep daemon home and credential paths denied regardless of project location.
- Prevent artifact paths from becoming arbitrary file-read handles.

#### Add hook interception without bypass

Pre/post tool hooks execute inside their own restricted profile. A hook may narrow, annotate, or deny an action; it may not widen the profile or call an ungoverned executor.

### Tests

- Complete escape corpus on Linux.
- Explicit fail-closed tests on macOS and Windows until equivalent enforcement exists.
- Permission matrix across every tool.
- PTY restart and output cursor tests.
- Network destination and DNS-rebinding tests.
- Environment secret filtering tests.
- Hook attempts to escalate privilege.

### Exit criteria

- No Relay-owned process spawns outside `SandboxExecutor`.
- No tool is advertised without a real executor.
- All escape tests pass on each supported platform or the platform is explicitly unsupported.
- Approval receipts include the exact requested and effective permission scope.
- Full-access cannot be selected where it cannot be enforced and audited accurately.

## Increment 5: Projection cutover and live clients

Effort: 2-3 engineering weeks
Depends on: Durable Turn, Safety
Gate: Projection Parity

### Objective

Make the browser a faithful resumable view of local canonical state and remove direct legacy execution ownership.

### Work

#### Publish the actual transactional outbox

- Claim bounded outbox batches under a lease.
- Publish canonical event rows and snapshots in strict per-run order.
- Accept only the next contiguous sequence or an exact duplicate.
- Advance local acknowledgement only after Convex confirms the durable cursor.
- Recover safely from a successful cloud write followed by a lost response.
- Apply redaction and payload bounds before enqueueing projection rows.

#### Complete command inbox semantics

- Browser mutations create versioned, authenticated command envelopes.
- Daemon ingress validates every payload as untrusted input.
- Convex delivery is at least once.
- Local receipts provide exactly-once effect.
- Commands expose queued, delivered, accepted, completed, rejected, and expired states.

#### Implement a real client runtime

The client runtime:

1. loads the newest snapshot;
2. subscribes after its sequence;
3. detects gaps;
4. requests a bounded catch-up page;
5. applies exact duplicates idempotently;
6. reconnects with backoff;
7. surfaces stale/offline state.

Use Convex reactive subscriptions rather than browser polling.

#### Cut the web to kernel data

- Replace `legacyRunData` in the run list and thread view.
- Render canonical messages, activity, approvals, tools, usage, checkpoints, artifacts, subagents, and diagnostics.
- Remove hardcoded provider/worktree labels.
- Derive the "Needs You" inbox from canonical pending interactions.
- Preserve direct links to existing legacy threads during migration.

#### Prove shadow parity

Compare:

- visible assistant text;
- activity order;
- approval states;
- usage totals;
- checkpoint identities;
- terminal status;
- command completion;
- redaction.

Differences are structured artifacts, not log strings. Any gap, duplicate effect, cross-owner read, or terminal-state mismatch blocks cutover.

### Tests

- Browser refresh at every event sequence.
- Offline for 10 minutes, then reconnect and catch up.
- Outbox publish response loss.
- Duplicate and reordered command delivery.
- Projection gaps and exact-duplicate acceptance.
- Owner/project/device authorization matrix.
- Legacy and kernel shadow comparison over representative fixtures.

### Exit criteria

- Kernel runs render entirely from projection tables.
- Browser state can be reconstructed from a snapshot and ordered events.
- Shadow parity meets the agreed threshold for a full soak window.
- Developer machines can opt into kernel read/write mode.
- Rollback to legacy remains possible without executing a turn twice.

## Increment 6: Migrate workflows and deliver real parallel agents

Effort: 2.5-4 engineering weeks
Depends on: Projection Parity
Gate: Competitive Floor

### Objective

Move Relay's useful workflow features behind the orchestration engine and turn worktree isolation into a real multi-agent scheduler.

### Work

#### Remove hot-worker ownership

Convert legacy workers into engine workflows or reactors:

- top-level turns;
- subagents and nested agents;
- checkpoints and restores;
- checkpoint comparison;
- Git actions;
- MCP calls and elicitation;
- review;
- plan approval;
- commands and background processes.

Replace independent 200 ms loops with one command transport and one effect scheduler.

#### Add durable task graphs

A task has:

- stable ID and parent;
- named role;
- objective and expected artifact;
- dependencies;
- state;
- capability ceiling;
- context budget;
- workspace mode;
- model/provider selection;
- lease and heartbeat;
- attempt policy;
- completion contract.

The scheduler runs the unblocked frontier under configurable machine, provider, and repository limits.

#### Implement parent-child communication

- Parent sends follow-up or cancellation.
- Child reports progress and terminal result.
- Parent receives terminal failures as failures, not empty success.
- Messages are canonical events.
- Child context is intentionally constructed rather than copying the entire parent transcript.

#### Harden worktree integration

- Persist the worktree before child execution.
- Detect conflicting writers.
- Capture child result as a checkpoint or patch artifact.
- Validate patch applicability before integration.
- Present conflicts for explicit resolution.
- Support partial selection of child changes.
- Never force-remove a worktree with unprojected result state.

#### Implement review and jury workflows

Reviewers operate against immutable diff/checkpoint artifacts. A reviewer jury may use different models and roles, but findings normalize to:

- severity;
- file and location;
- evidence;
- recommendation;
- disposition;
- source reviewer.

Addressing findings is a separate child task with traceable resolution.

### Tests

- Parallel readers and isolated writers on the same repository.
- Dependency ordering in a task DAG.
- Parent cancellation while child is running or awaiting approval.
- Child crash and lease recovery.
- Patch conflict, partial integration, and rejected result.
- Reviewer disagreement and deduplication.
- Maximum-depth and capability-narrowing enforcement.

### Exit criteria

- At least four independent runs execute concurrently under a configured limit.
- A parent can delegate three tasks in parallel and integrate their selected results.
- No workflow changes run state outside the engine.
- Worktree conflicts are explicit and recoverable.
- The legacy per-work-type polling loops are inactive in kernel mode.
- The end-to-end competitive acceptance scenario passes.

## Increment 7: Stable extensibility platform

Effort: 2-3 engineering weeks
Depends on: Competitive Floor
Gate: Extensible Platform

### Objective

Let Relay compete on adaptability instead of trying to ship every workflow itself.

### Work

#### Define a versioned extension manifest

An extension may contribute:

- skills;
- slash commands;
- tool definitions;
- lifecycle hooks;
- provider adapters;
- context contributors;
- approval classifiers;
- artifact renderers;
- web panels;
- task roles and workflow templates.

The manifest declares:

- API version;
- capabilities;
- trust requirements;
- runtime entry points;
- UI assets;
- configuration schema;
- compatibility range.

#### Define lifecycle hooks

Initial events:

- daemon/session start and stop;
- run create, resume, and stop;
- turn start and terminal;
- before and after context construction;
- before and after compaction;
- before approval;
- before and after tool execution;
- tool failure;
- task start and terminal;
- checkpoint capture and restore;
- projection publish;
- workspace create and remove.

Hooks receive bounded typed input and return a typed decision. Timeouts and failures are explicit events.

#### Add custom tool registration

Custom tools use the same registry, governance, sandbox, event, artifact, and rendering contracts as built-ins. Extensions cannot acquire an executor or permission unavailable to the host profile.

#### Add packaging and discovery

- project, user, managed, and bundled scopes;
- project trust gate;
- local paths and signed packages;
- deterministic resolution and shadowing;
- dependency and compatibility diagnostics;
- hot refresh for safe metadata changes;
- restart-required boundary for executable changes.

#### Port existing extensibility work

Move existing skills, slash commands, trust, todo, hooks, MCP, background-shell, and provider-directory work to the kernel-facing APIs. Do not keep separate legacy and kernel implementations.

### Tests

- Extension compatibility contract across API versions.
- Trust denied, changed manifest, and revoked package.
- Hook timeout, crash, deny, and annotation.
- Custom tool execution under each permission profile.
- Two extensions with conflicting names.
- Uninstall while runs reference an extension version.

### Exit criteria

- A sample external extension can add one tool, one hook, one skill, and one browser renderer without modifying Relay core.
- Extension removal does not make old run history unreadable.
- Project extensions never load before an explicit trust decision.
- Every extension action is attributable in audit and diagnostics.

## Increment 8: Reliability, evaluation, and default cutover

Effort: 2-3 engineering weeks plus ongoing benchmark maintenance
Depends on: Safety, Projection Parity, Competitive Floor
Gate: kernel default

### Objective

Prove Relay is reliable enough to replace the legacy path and measure whether agent quality is improving.

### Work

#### Build a harness evaluation suite

Evaluate:

- repository navigation;
- precise edits;
- iterative test repair;
- long-context retention;
- instruction hierarchy;
- permission refusal recovery;
- provider and daemon crash recovery;
- concurrent worktree isolation;
- subagent task decomposition;
- review quality;
- latency and token efficiency;
- tool-call correctness;
- sandbox escapes.

Use deterministic fixtures for correctness and a pinned real-model suite for product quality. Record model, provider, prompt version, tool versions, tokens, latency, result, and artifact hashes.

#### Define service-level objectives

Initial targets:

- command accepted locally: p95 under 500 ms while online;
- first visible activity: p95 under 2 s excluding provider queue time;
- projection catch-up: p95 under 2 s for 1,000 missed events;
- no sequence gaps or duplicate side effects;
- active-run recovery: p95 under 15 s after daemon restart;
- idle daemon: no 200 ms cloud polling;
- tool output and event storage bounded by retention policy.

Targets must be measured and revised from data, not hardcoded as marketing claims.

#### Add joined observability

- Stable correlation and causation IDs from browser command through provider, tool, checkpoint, and projection.
- OpenTelemetry-compatible traces.
- Metrics with correct gauges and counters.
- Provider, sync, store, sandbox, and scheduler health.
- Redacted diagnostic export.
- Per-run replay viewer.

#### Add real process supervision

- OS service integration;
- graceful shutdown and lease release;
- restart backoff;
- provider child ownership;
- startup reconciliation;
- version compatibility;
- migration failure handling.

#### Rehearse backup and restore

- SQLite online backup;
- event and artifact integrity verification;
- restore to a clean daemon home;
- corruption detection and quarantine;
- pre-upgrade backup;
- documented rollback.

#### Roll out in stages

1. Local development with fake provider.
2. Opt-in developer machines with Codex.
3. Shadow projection soak.
4. Kernel canary machines.
5. Kernel default with emergency legacy flag.
6. One release window with zero required legacy activations.
7. Remove legacy workers, tables, and runtime flag.

Automatic rollback triggers:

- sequence gap;
- duplicate side effect;
- cross-owner access;
- sandbox escape;
- unrecoverable active run;
- projection divergence;
- provider event routed to the wrong run;
- backup or migration integrity failure.

### Exit criteria

- Kernel is default on supported platforms.
- Production acceptance passes on the supported OS matrix.
- Recovery kill-point suite is green.
- Sandbox and authorization adversarial suites are green.
- SLO dashboard and diagnostic export are operational.
- One release window completes without a required legacy activation.
- Legacy removal follows the widen-migrate-narrow plan and has recorded rollback evidence.

## Increment 9: Build the Relay edge

Effort: staged after kernel default
Depends on: Extensible Platform and kernel default
Gate: Relay Edge

### Objective

Ship capabilities that exploit Relay's durable remote architecture rather than imitate terminal competitors.

### Agent Time Machine

- Select any canonical sequence or checkpoint.
- Reconstruct run state and context lineage.
- Restore in place when safe.
- Fork into a new isolated run by default.
- Compare workspace, context, usage, approvals, and outcome.
- Preserve provenance between parent and fork.

### Visual parallel task graph

- Display task dependencies, state, model, budget, worktree, and attention needs.
- Allow operator reprioritization and cancellation.
- Open any child transcript and artifacts.
- Select results for integration.
- Surface conflicts before merge.

### Provider-independent handoff

- Export canonical context package.
- Start a new provider session against the same run or fork.
- Preserve tool receipts, artifacts, decisions, and unresolved work.
- Record which provider produced each event.
- Support reviewer models without exposing provider-private reasoning.

### Operator inbox

One "Needs You" surface for:

- approvals;
- MCP and provider elicitation;
- merge conflicts;
- plan review;
- failed recovery;
- budget exhaustion;
- trust requests;
- extension changes;
- task ambiguity.

Support browser notifications and resumable deep links.

### Deterministic replay and comparison

- Replay reducer and projections from canonical events.
- Compare provider versions, models, prompts, tool sets, and policies.
- Detect the first divergent decision or tool result.
- Promote successful runs into regression fixtures.

### Exit criteria

- A user can rewind, fork, compare, and selectively integrate an alternate solution.
- A multi-agent task graph remains understandable and controllable from the browser.
- A run can hand off between two provider adapters without losing canonical work state.
- Every attention request is actionable from one inbox.

## Competitive acceptance scenario

The following scenario is the release-defining vertical test. It must run against the deterministic fake in CI and against real Codex in an opt-in environment.

1. Pair a browser with a daemon and register a fixture repository.
2. Create two kernel runs with `workspace-write`.
3. In run A, request a feature whose first implementation fails a test.
4. Confirm the agent searches, reads, edits, tests, diagnoses, edits, and retests.
5. During the turn, send steering that changes a non-conflicting requirement.
6. Trigger a risky command and confirm the run enters `awaiting_approval`.
7. Deny it; confirm execution does not occur and the agent adapts.
8. Trigger an allowed workspace write and capture pre/post checkpoints.
9. Kill the provider during streaming; confirm recovery or one accurate failure.
10. Retry, then kill the daemon after an effect is durable but before its acknowledgement.
11. Restart; confirm the effect is not duplicated and the turn resumes.
12. Refresh the browser from a stale cursor; confirm ordered catch-up.
13. In run B, delegate three read/review tasks in parallel.
14. Integrate one child result and reject another.
15. Fork run A from its pre-turn checkpoint and implement an alternate solution with a second provider or deterministic adapter.
16. Compare both solutions and select one.
17. Export a redacted diagnostic and canonical run history.

The scenario fails on:

- any simulated assistant content;
- missing or duplicated visible events;
- duplicated tool execution;
- wrong-run provider event routing;
- an action escaping its permission profile;
- unrecoverable or falsely completed turn state;
- context that forgets the active goal or steering;
- browser state that cannot be reconstructed after refresh.

## Quality gates for every task

Every implementation task must include:

1. A failing test that represents observable behavior.
2. Runtime schema validation at untrusted or persisted boundaries.
3. Idempotency behavior.
4. Cancellation and timeout behavior.
5. Restart/replay behavior when stateful.
6. Permission and redaction behavior.
7. Structured diagnostics.
8. Documentation of any unsupported platform behavior.

Before merging:

```bash
bun run typecheck
bun run test
bun run build
bun run bundle:check
```

Run the relevant conformance, recovery, sandbox, and real-provider suites when their scope changes.

## Program dashboard

Track these measures by increment:

| Measure | Baseline | Competitive-floor target |
|---|---:|---:|
| Real multi-step coding-task pass rate | establish in Increment 0 | at least 80% on pinned suite |
| Duplicate effects under retry/restart | not proven | 0 |
| Event sequence gaps | not proven | 0 |
| Sandbox escape cases | incomplete suite | 0 on supported platforms |
| Active run recovery | partial/stubbed | 100% recover or accurate terminal failure |
| Context invariant retention | not measured | 100% pinned invariants |
| Concurrent isolated runs | effectively 1 top-level legacy turn | at least 4 configurable |
| Browser reconnect correctness | polling/legacy dependent | exact snapshot + cursor replay |
| Provider conformance | partial Codex adapter | fake + Codex fully green |
| Advertised no-op tools | present | 0 |

## Work that should not interrupt this program

Until the Competitive Floor gate passes, defer:

- more static model catalog breadth;
- cosmetic panels without a canonical data source;
- new legacy worker types;
- additional reviewer role names without task-graph execution;
- second real provider integration;
- marketplace work before the extension API is versioned;
- mobile-native clients;
- cloud execution that changes local-authority boundaries;
- schema narrowing;
- performance optimization without measured traces.

Critical security fixes, data-loss fixes, and migration blockers are always in scope.

## First implementation slice

The first slice should be small enough to merge safely and strong enough to change the trajectory:

1. Add the failing kernel truth characterizations.
2. Remove the simulated local runtime reply.
3. Route `sendTurn` through the orchestration engine.
4. Make reducer application and snapshot update atomic.
5. Implement live `observe`.
6. Replace the stub provider effect with the deterministic fake reactor.
7. Enforce a real two-run concurrency limit.
8. Prove restart and duplicate-command behavior in SQLite integration tests.

Do not begin browser cutover or new tool work until this slice passes the `HarnessRuntime` contract. It establishes the seam every later increment depends on.

## Final definition of done

Relay is competitive when its default experience is not merely feature-rich, but trustworthy:

- the agent can perform real iterative coding work;
- it remembers and compacts accurately;
- tools return truthful results;
- permissions are technically enforced;
- runs recover instead of strand;
- several agents can work concurrently without corrupting each other;
- the browser is an exact resumable view of local authority;
- providers are replaceable behind a tested contract;
- extensions use stable governed APIs;
- users can rewind, fork, compare, review, and intervene from anywhere.

That is the edge Relay's current worktree, checkpoint, governance, browser, and event-kernel foundations are capable of supporting.
