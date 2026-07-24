# Relay harness runtime rebuild implementation plan

**Status:** Approved architecture; ready for implementation  
**Date:** 2026-07-23  
**Primary decision record:** `docs/adr/0006-relay-owned-agent-control-provider-native-sessions.md`

## Goal

Make the harness kernel Relay's sole production execution authority and give it a real, durable agent runtime: recoverable external effects, provider-session isolation, governed and sandboxed tools, deterministic parallel execution, durable subagents, explicit workspace ownership, coherent context and compaction, and release evidence that exercises the production seams.

The finished system must preserve Relay's existing strengths:

- Local SQLite execution authority.
- Typed commands and append-only canonical events.
- Pure state decisions and durable effects.
- Exactly-once command receipts.
- Per-run FIFO scheduling with bounded cross-run concurrency.
- Leases, fences, retry classes, and projection outbox convergence.
- Convex as authenticated command ingress and browser projection, never execution authority.

This is the master implementation sequence for the harness. Narrower plans remain useful as historical evidence, but this plan governs when their implementation choices conflict with the approved architecture.

## Approved architectural boundary

Relay always owns:

- Run, turn, agent, task, workspace, and canonical activity identity.
- Commands, events, effects, receipts, snapshots, and recovery state.
- Agent topology, mailboxes, resource limits, and task scheduling.
- Governance, operator approvals, workspace ownership, and projection semantics.

A stateful provider owns:

- Its native session and model-visible native history.
- Its native model/tool loop where that is part of the provider.
- Native thread, turn, item, and process identifiers.

A raw provider has no durable native loop. Relay executes it through the canonical execution-step runtime.

Every provider path emits the same bounded canonical lifecycle and is subject to the same Relay governance rules. Provider-native children and approvals must be represented in Relay or disabled.

## Non-goals

The first implementation program does not include:

- Cross-run learned memory.
- Arbitrary remote worker distribution.
- Autonomous cloud scheduling.
- A plugin marketplace.
- A broad UI redesign.
- Provider-specific behavior with no canonical Relay semantics.
- Replacing SQLite authority with JSONL, Convex, or a provider transcript.

## Current implementation facts driving the work

1. The effect contract says `execute` runs at most once, but production recovery paths repeat provider, approval, steering, interruption, and checkpoint execution.
2. Kernel subagents currently produce one streamed reply without a real tool loop or isolated worktree.
3. The local turn loop executes tool calls sequentially and does not expose iteration exhaustion.
4. The local kernel provider path begins a turn with the current prompt rather than a reconstructed canonical history.
5. OS sandbox adapters are not the path used by the production command tool.
6. One daemon-wide Codex adapter and a promise tail serialize Codex-backed runs.
7. Codex threads are started with approvals disabled rather than translating native approval requests into Relay approvals.
8. Task graph, scheduler, context, provider registry, sandbox, and extension modules have incomplete production integration.
9. `KernelDaemon` combines composition, provider execution, tools, agents, workflows, checkpoints, projection publishing, and lifecycle supervision.
10. The fast test suite is broad and passing, but critical real Codex and cross-tier cases remain protected or skipped.

## Target package boundaries

Dependency direction must remain one-way:

```text
@relay/contracts
    ↑
@relay/local-store        @relay/workspace-runtime
    ↑                         ↑
@relay/provider-runtime   @relay/tool-runtime (new)
    ↑                         ↑
@relay/orchestration
    ↑
@relay/harness-runtime
    ↑
@relay/daemon
    ↓
Convex command ingress / projections
```

Responsibilities:

- `contracts`: versioned domain types and runtime validation only.
- `local-store`: transactional persistence, migrations, leases, and codecs.
- `workspace-runtime`: worktree lifecycle, confinement, checkpoints, and integration.
- `provider-runtime`: provider capabilities and scoped native sessions.
- `tool-runtime`: executable tool registry, governance, sandbox orchestration, limits, persistent processes.
- `orchestration`: pure state decisions, scheduling, effect intent, agent/task state transitions.
- `harness-runtime`: public lifecycle, execution-step runtime, context compiler, agent control coordination.
- `daemon`: composition, local adapters, Convex synchronization, process supervision.

No lower package may import the daemon or browser projection code.

## Global implementation rules

1. Add a failing test before changing each durable behavior.
2. Widen schemas before changing producers or consumers.
3. Never combine an irreversible schema contraction with a runtime behavior cutover.
4. Every new external operation must declare execute, reconcile, timeout, cancellation, and uncertainty behavior.
5. Every advertised tool must have an executable handler in the current runtime.
6. Model-visible ordering must be deterministic even when execution is concurrent.
7. Do not add a second production path while leaving the superseded path indefinitely. Prove the replacement, switch callers, then delete the old path.
8. Do not infer state from assistant prose.
9. Preserve existing user changes in the worktree and keep commits scoped by work package.
10. Protected live tests may use credentials, but the ordinary unit suite must remain deterministic and offline.

## Delivery map

```text
Phase 0  Baseline and architecture fences
   ↓
Phase 1  External-operation reconciliation
   ↓
Phase 2  Tool orchestrator and real sandbox
   ↓
Phase 3  Scoped provider sessions and native approvals
   ↓
Phase 4  Durable agent control plane
   ↓
Phase 5  Tasks, workspaces, and integration
   ↓
Phase 6  Context compiler, compaction, and execution steps
   ↓
Phase 7  Parallel tools, persistent processes, deferred discovery
   ↓
Phase 8  Rich Codex normalization and capability exposure
   ↓
Phase 9  Kernel decomposition and dead-path removal
   ↓
Phase 10 Production evidence, kernel-default promotion, legacy deletion
```

Phases 2 and the contract-only part of Phase 3 may proceed in parallel after Phase 1's operation model is fixed. Later phases must not bypass their predecessor's exit gate.

---

## Phase 0 — Baseline and architecture fences

### Objective

Prevent new work from deepening the duplicate-runtime architecture and capture the production behavior that migrations must preserve.

### Work package 0.1 — Name the canonical paths

**Change**

- Add architecture-contract tests that identify:
  - `LocalHarnessRuntime` as the only local `HarnessRuntime`.
  - `ProviderSessionRegistry` as the only owner of scoped provider sessions.
  - The future `ToolOrchestrator` as the only command/tool execution path.
  - Kernel mode as the only target for new capabilities.
- Add comments only at actual module boundaries, not throughout implementation code.
- Mark legacy entry points as migration-only through naming and import restrictions.

**Files**

- `apps/daemon/src/architecture-contract.test.ts`
- `apps/daemon/src/index.ts`
- `packages/harness-runtime/src/index.ts`
- `packages/provider-runtime/src/index.ts`

**Acceptance**

- A test fails if a new daemon module directly constructs a provider session or spawns a governed shell outside the approved composition modules.

### Work package 0.2 — Characterize existing semantics

Add characterization tests for:

- Duplicate command delivery.
- Provider completion followed by persistence failure.
- Approval suspension and resolution.
- Steering and interruption during an active provider effect.
- Checkpoint capture at the turn boundary.
- Canonical projection convergence after an unavailable Convex sink.
- Current Codex global serialization, marked as behavior to replace rather than preserve.
- Iteration exhaustion in the raw-provider turn loop.

**Files**

- `apps/daemon/src/legacy-runtime.characterization.test.ts`
- `apps/daemon/src/kernel-daemon.wiring.test.ts`
- `apps/daemon/src/kernel-daemon.control.test.ts`
- `packages/orchestration/src/orchestration-engine.integration.test.ts`
- `packages/harness-runtime/src/local-harness-runtime.integration.test.ts`

### Work package 0.3 — Establish baseline evidence

Record successful output for:

```bash
bun run typecheck
bun run test
bun run build
bun run security:gate
bun run codex:schema:check
bun run conformance:matrix
bun run crash:matrix
```

### Exit gate

- Baseline is green.
- New architecture tests prevent accidental new dependencies on legacy paths.
- No production behavior has changed.

---

## Phase 1 — External-operation reconciliation

### Objective

Make the durable-effect guarantee true: an external side effect is dispatched at most once, and every later attempt reconciles or becomes durably uncertain.

### Work package 1.1 — Add an external-operation journal

Add a local-store migration for `external_operations`:

```text
operation_id             primary key
effect_id                unique, foreign identity
idempotency_key          unique
run_id
operation_kind
state                    prepared | dispatched | observed | committed | outcome_unknown
provider_instance_id     optional
native_reference         optional, versioned bounded payload
prepared_at
dispatched_at            optional
observed_at              optional
committed_at             optional
last_error               optional, bounded
schema_version
```

The state machine is monotonic. No transition may move from `dispatched` back to `prepared`.

**Files**

- `packages/local-store/src/database.ts`
- `packages/local-store/src/external-operation-store.ts` (new)
- `packages/local-store/src/persistence-codecs.ts`
- `packages/local-store/src/external-operation-store.integration.test.ts` (new)
- `packages/contracts/src/effects.ts`
- `packages/contracts/src/runtime-schemas.ts`

### Work package 1.2 — Strengthen the reactor contract

Replace implicit attempt-number behavior with explicit operations:

```ts
type EffectReactor = {
  prepare(effect, context): Promise<PreparedOperation>;
  execute(prepared, context): Promise<ObservedOperation>;
  reconcile(operation, context): Promise<ObservedOperation | OutcomeUnknown>;
};
```

The final shape may use equivalent names, but must preserve these semantics:

- `prepare` is durable before dispatch.
- `execute` is never called for an already dispatched operation.
- `reconcile` receives all known native identifiers.
- `OutcomeUnknown` blocks rather than retries.
- Result persistence remains protected by the effect lease fence.

### Work package 1.3 — Convert each production reactor

Convert, in order:

1. Provider session start/resume/stop.
2. Provider turn send.
3. Approval resolution.
4. Tool execution.
5. Checkpoint capture/restore.
6. Workspace create/integrate.
7. Steering and interruption.

For Codex:

- Use JSON-RPC request identity plus native thread/turn IDs.
- Reconcile through thread/turn reads and terminal notifications.
- If a crash occurs before any native reference is recoverable and Codex cannot query by the Relay key, record `outcome_unknown`.

For raw providers:

- Pass the Relay idempotency key when supported.
- Otherwise declare the provider turn non-retryable after dispatch.

**Files**

- `apps/daemon/src/kernel-daemon.ts`
- `apps/daemon/src/provider-reactors.ts`
- `packages/orchestration/src/workflow-reactors.ts`
- `packages/providers/codex-app-server/src/codex-session-adapter.ts`
- `packages/provider-runtime/src/provider-session.ts`

### Work package 1.4 — Kill-point matrix

Add deterministic kill points:

```text
after_operation_prepare
before_external_dispatch
after_external_dispatch
after_native_id_observed
before_canonical_result
after_canonical_result
before_effect_completion
```

For each external operation, restart the runtime and prove:

- No duplicate external call.
- Exactly one canonical terminal result, or one `outcome_unknown`.
- No active run remains silently stranded.
- Projection eventually converges.

**Files**

- `apps/daemon/src/reliability/kill-points.ts`
- `scripts/run-crash-matrix.ts`
- `apps/daemon/src/cross-tier-recovery.integration.test.ts`
- `apps/daemon/src/cross-tier-recovery.e2e.test.ts`

### Exit gate

- No production `recover` implementation invokes its reactor's original `execute`.
- Crash matrix covers every external operation state.
- A provider completion/persistence crash cannot produce a second turn.
- Unreconcilable operations become visible needs-you items.

---

## Phase 2 — Tool orchestrator and real sandbox

### Objective

Create one enforceable path from a tool request to policy, approval, sandbox, execution, audit, and result.

### Work package 2.1 — Create `@relay/tool-runtime`

Add:

```text
packages/tool-runtime/
  src/tool-definition.ts
  src/tool-registry.ts
  src/tool-orchestrator.ts
  src/tool-result.ts
  src/process-manager.ts
  src/index.ts
```

A tool definition binds:

- Stable name and version.
- Input and output schema.
- Executable handler.
- Visibility and discovery metadata.
- Capability and risk classification.
- Parallel safety.
- Side-effect scope.
- Reconciliation class.
- Timeout and output budget.
- Sandbox and network requirements.

Move or adapt the useful behavior from:

- `apps/daemon/src/tool-registry.ts`
- `apps/daemon/src/tool-executor.ts`
- `apps/daemon/src/governed-tool-executor.ts`
- `apps/daemon/src/policy.ts`

Do not delete the old modules until every caller has switched.

### Work package 2.2 — Centralize the execution pipeline

Every tool follows:

```text
validate schema
→ classify capability and risk
→ intersect run, agent, tool, and platform permissions
→ allow / deny / request approval
→ select sandbox
→ enforce timeout and output budget
→ execute
→ classify result
→ persist audit and canonical events
→ reconcile if dispatch already occurred
```

A retry with broader permissions is a new governed decision, never an automatic fallback.

### Work package 2.3 — Put OS sandboxing on the production path

Correct platform adapters:

- Linux:
  - Honor read roots, write roots, network policy, environment, process limit, and full-access semantics.
  - Use asynchronous spawning.
  - Fail closed if Bubblewrap is required but unavailable.
- macOS:
  - Generate a Seatbelt profile that permits required system binaries and configured roots.
  - Honor network and permission profiles.
- Windows:
  - Remain fail-closed until the configured restricted-token/AppContainer implementation reports ready.

**Files**

- `packages/workspace-runtime/src/sandbox/sandbox-executor.ts`
- `packages/workspace-runtime/src/sandbox/linux-bwrap.ts`
- `packages/workspace-runtime/src/sandbox/macos-seatbelt.ts`
- `packages/workspace-runtime/src/sandbox/windows-policy.ts`
- `packages/workspace-runtime/src/sandbox/sandbox.contract.test.ts`

### Work package 2.4 — Secure filesystem tools

- Replace lexical-only containment with real-target containment.
- Reject symlink traversal outside approved roots.
- Defend mutations against target replacement races.
- Stream bounded file ranges instead of reading an entire large file before truncating.
- Preserve exact encoding/error behavior in canonical results.

**Files**

- `apps/daemon/src/tools.ts`
- New filesystem handlers under `packages/tool-runtime` or `packages/workspace-runtime`.

### Work package 2.5 — Expand the escape suite

Prove technical denial for:

- Parent-directory traversal.
- Absolute paths outside roots.
- Symlink-to-file escape.
- Symlink-to-directory escape.
- Symlink replacement between validation and write.
- `.env` reads outside allowed roots.
- `/proc/*/environ`.
- Unauthorized network access.
- Environment-variable leakage.
- Child-process fan-out beyond limits.

### Exit gate

- No governed shell uses direct `Bun.spawn` outside the tool/process runtime.
- No workspace filesystem mutation bypasses real-target containment.
- Declared timeouts and output limits are enforced.
- Escape suite passes on supported platforms and unsupported platforms fail closed.
- `bun run security:gate` passes.

---

## Phase 3 — Scoped provider sessions and native approvals

### Objective

Make provider sessions independently concurrent, durable, capability-negotiated, and governed.

### Work package 3.1 — Define provider capabilities

Add a versioned capability snapshot:

```ts
type ProviderCapabilities = {
  nativeHistory: boolean;
  nativeToolLoop: boolean;
  nativeSubagents: boolean;
  approvals: ReadonlySet<ApprovalKind>;
  threadFork: boolean;
  threadRollback: boolean;
  compaction: "none" | "local" | "remote";
  persistentProcesses: boolean;
  dynamicTools: boolean;
};
```

Capabilities are obtained when a provider instance initializes and are stored with the provider session.

**Files**

- `packages/provider-runtime/src/provider-driver.ts`
- `packages/provider-runtime/src/provider-session.ts`
- `packages/contracts/src/provider.ts` (new)
- `packages/providers/codex-app-server/src/codex-driver.ts`

### Work package 3.2 — Promote `ProviderSessionRegistry`

Key sessions by stable Relay identity:

```text
run_id + agent_id + provider_instance_id
```

Persist:

- Native thread/session ID.
- Capability snapshot version.
- Lifecycle state.
- Last native turn ID.
- Last observed canonical sequence.
- Residency state.

Only the registry creates, loads, and closes adapters.

### Work package 3.3 — Remove global Codex serialization

- Create one Codex session adapter per resident Relay agent.
- Route notifications by native thread and turn ID.
- Remove `codexTurnTails` and the daemon-wide adapter.
- Add a bounded connection/session policy rather than serializing all runs.
- Verify two runs overlap in wall-clock execution.

### Work package 3.4 — Translate native approvals

Normalize these Codex server requests into Relay approval records:

- Command execution.
- File change.
- MCP tool or elicitation.
- Guardian-reviewed escalation where exposed.

Suspension must preserve the native request ID. Approval resolution responds to the same native request after restart or records a durable terminal failure if the provider can no longer accept it.

Remove `approvalPolicy: "never"` as the blanket integration behavior. Policy selection must derive from the Relay permission profile and governance configuration.

### Work package 3.5 — Provider conformance

Extend the provider contract suite to cover:

- Start, resume, stop.
- Concurrent sessions.
- Turn send and terminal event.
- Steering and interruption.
- Approval suspension/resolution.
- Native identifier persistence.
- Crash/reconcile behavior.
- Backpressure and notification recovery.

### Exit gate

- Two Codex-backed Relay runs execute concurrently.
- Native approvals appear and resolve through Relay.
- Provider sessions survive daemon restart through the registry.
- No daemon code outside the registry directly owns a provider adapter.

---

## Phase 4 — Durable agent control plane

### Objective

Replace text-only delegated replies with durable agents that can work, communicate, stop, resume, and survive runtime eviction.

### Work package 4.1 — Add canonical agent contracts

Add branded IDs and discriminated types:

```text
AgentId
AgentPath
AgentStatus
AgentResidency
AgentRole
AgentBudget
AgentSpawnSpec
AgentMessage
AgentResult
```

Statuses:

```text
created
ready
running
waiting
blocked
completed
failed
interrupted
closed
```

Residency is independent:

```text
resident
evicted
restoring
```

Add canonical events:

```text
agent.created
agent.started
agent.status.changed
agent.message.queued
agent.message.delivered
agent.evicted
agent.restored
agent.completed
agent.failed
agent.closed
```

**Files**

- `packages/contracts/src/agents.ts` (new)
- `packages/contracts/src/ids.ts`
- `packages/contracts/src/events.ts`
- `packages/contracts/src/commands.ts`
- `packages/contracts/src/runtime-schemas.ts`
- `packages/contracts/src/state.ts`

### Work package 4.2 — Persist agents, edges, mail, and resources

Add or widen local tables:

```text
agents
agent_spawn_edges
agent_mailbox
agent_resource_ledger
```

Required constraints:

- Stable unique agent path within a root tree.
- Stable parent edge.
- FIFO mailbox sequence per agent.
- Idempotent message delivery ID.
- Monotonic terminal state.
- Separate execution and residency states.
- Bounded task/message payloads.

### Work package 4.3 — Implement control operations

Add to `HarnessRuntime` or a nested `AgentControl` seam:

```text
spawnAgent
sendAgentMessage
followupAgent
waitForAgents
listAgents
interruptAgent
resumeAgent
closeAgent
```

Semantics:

- `sendAgentMessage` queues without starting an idle agent.
- `followupAgent` queues and makes an idle/completed-but-followable agent runnable.
- `waitForAgents` waits for state changes without busy polling.
- Interrupt cascades only when explicitly requested.
- Closing an agent closes or reassigns unfinished tasks by policy.

### Work package 4.4 — Atomic capacity reservations

Enforce:

- Maximum tree size.
- Maximum active executions.
- Maximum resident runtimes.
- Maximum depth.
- Per-agent and tree token budgets.
- Per-agent and tree wall-clock budgets.

Reserve capacity transactionally before provider/workspace creation. Release automatically when construction fails.

### Work package 4.5 — Context forks

Support:

```text
none
all
last_n_turns
artifact_packet
```

Before a fork:

- Flush the parent's canonical event transaction.
- Flush provider-native history when the provider supports it.
- Record the exact parent sequence and native provider reference used.
- Reject a fork from an uncommitted or uncertain parent boundary.

### Work package 4.6 — Residency and lazy restoration

- Evict only idle agents with flushed provider and Relay state.
- Select eviction candidates by bounded LRU policy.
- Preserve agent identity and mailbox while evicted.
- Restore on follow-up or explicit resume.
- Reapply the recorded provider capability, model, effort, role, permission profile, and workspace.

### Work package 4.7 — Remove the text-only subagent adapter

Switch kernel task calls and reviewer workflows to the control plane. Then delete:

- `apps/daemon/src/adapters/subagent-adapter.ts`
- Equivalent one-shot workflow paths that cannot execute tools.

Retain legacy subagent code only until Phase 10 cutover.

### Exit gate

- A child reads code, executes an allowed command, edits an isolated workspace, and returns a durable result.
- Parent and child can exchange multiple messages.
- Capacity cannot be exceeded by concurrent spawn races.
- A daemon restart restores agent state without duplicating work.
- An evicted child can be followed up with its role, history, permissions, and workspace intact.

---

## Phase 5 — Tasks, workspaces, and integration

### Objective

Make tasks durable work and agents durable workers, with explicit workspace ownership and conflict-aware integration.

### Work package 5.1 — Separate task from agent state

Refactor `TaskSpec` into discriminated creation and runtime state rather than one optional-field bag.

Task lifecycle:

```text
created
blocked
ready
assigned
running
completed
failed
cancelled
```

Assignment is a relationship, not task identity. Retrying or reassigning a task never changes its task ID.

### Work package 5.2 — Put `TaskGraph` and `TaskScheduler` in production

- Validate dependencies at creation.
- Reject cycles.
- Derive the ready frontier.
- Claim tasks transactionally.
- Respect agent capability and workspace constraints.
- Apply attempt and backoff policy.
- Propagate dependency failure according to explicit task policy.
- Wake scheduling from durable state changes, not polling.

Delete these modules if production integration reveals that the control plane alone fully replaces them; do not leave a second unused scheduler.

### Work package 5.3 — Durable workspace ownership

Widen workspace records:

```text
workspace_id
run_id
owner_agent_id
mode                 authoritative | shared_read_only | isolated_writer
repo_path
worktree_path
base_commit
permission_profile
state
created_at
integrated_at
```

Rules:

- One mutable owner per worktree.
- Researchers and reviewers use shared read-only access.
- Writers use isolated worktrees.
- Workspace creation is a reconciled external operation.
- Closing an agent does not silently discard an unintegrated writer result.

### Work package 5.4 — Explicit integration protocol

A writer returns:

- Base commit.
- Head commit or patch artifact.
- Changed paths.
- Test evidence.
- Summary.

Integration:

1. Verify the parent base.
2. Detect conflicts and overlapping ownership.
3. Apply through the workspace runtime.
4. Run configured validation.
5. Emit success, conflict, or rejection events.
6. Preserve the child artifact for review regardless of outcome.

Do not auto-merge unreviewed writer output.

### Work package 5.5 — Make plan and review workflows real

- Plan is a versioned artifact with draft, review, approved, building, and complete phases.
- Reviewer agents receive explicit code/artifact context and read-only tools.
- Review findings and resolutions are typed events.
- A reviewer jury runs through real agents, not parallel text completions.

### Exit gate

- Dependency scheduling executes only the ready frontier.
- Task identities remain stable across reassignment and retry.
- Two writer agents cannot mutate the same worktree.
- Integration conflicts are durable operator-visible states.
- Reviewer findings are grounded in the actual workspace.

---

## Phase 6 — Context compiler, compaction, and execution steps

### Objective

Give raw providers a coherent, resumable agent loop and make Relay-supplied context explicit for every provider.

### Work package 6.1 — Replace context prototypes with one compiler

Create:

```text
packages/harness-runtime/src/context/
  context-compiler.ts
  history-invariants.ts
  world-state.ts
  token-budget.ts
  compaction.ts
  provenance.ts
```

The compiler inputs:

- Canonical instructions.
- Current run, turn, agent, task, and workspace state.
- Permission profile and tool availability.
- Valid conversation history.
- Goal and approved plan.
- Pending approvals and unresolved review comments.
- Agent tree and mailbox.
- Selected artifacts.
- Previous model-visible snapshot.

The output contains:

- Provider-ready messages/items.
- Structured world-state delta.
- Tool definitions or deferred discovery tool.
- Exact provenance and token estimate.
- Compaction decision.

### Work package 6.2 — Enforce history invariants

Always preserve:

- Tool call/result pairing.
- Approval request/resolution pairing.
- Assistant item ordering.
- Compaction summary provenance.
- Pinned initial context.
- Active goal and approved plan.
- Unresolved review comments.
- Valid modality for the selected provider.

Oversized tool output becomes a bounded artifact reference plus summary, not a malformed partial tool result.

### Work package 6.3 — Distinguish provider-native and Relay history

For native-history providers:

- Do not resend the complete conversation.
- Supply structured Relay state and the current task/turn input.
- Record the exact Relay context additions and provider thread reference.

For raw providers:

- Compile the complete eligible model history from canonical events and artifacts.

Never claim that hidden provider reasoning is reconstructable Relay history.

### Work package 6.4 — Durable compaction

Add:

```text
context.compaction.started
context.compaction.completed
context.compaction.failed
```

A compaction artifact records:

- Trigger and reason.
- Source sequence range.
- Pinned items.
- Retained recent turns.
- Summary.
- Token counts before and after.
- Provider and model used.
- Provenance and schema version.

Compaction is idempotent by source range and policy version. Resume and fork consume only a validated replacement history.

### Work package 6.5 — Canonical execution-step runtime

Replace the raw-provider loop with:

```text
compile context
→ begin model sample
→ stream typed items
→ collect tool requests
→ execute governed tools
→ append deterministic results
→ drain steering and mailbox atomically
→ compact if required
→ continue or terminate with typed reason
```

Terminal reasons:

```text
completed
approval_pending
interrupted
failed
budget_exhausted
iteration_exhausted
outcome_unknown
```

No silent `maxIterations` exit.

### Work package 6.6 — Retire duplicate raw loops

After all raw-provider callers use the execution-step runtime:

- Delete or reduce `apps/daemon/src/turn-loop.ts`.
- Delete duplicate behavior from `apps/daemon/src/kernel-agentic-turn.ts`.
- Keep `agent-loop.ts` only as legacy characterization until Phase 10.

### Exit gate

- A raw-provider run resumes with correct prior history after restart.
- Tool history remains structurally valid after truncation and compaction.
- The exact Relay-supplied context is inspectable for every step.
- Iteration and token exhaustion are visible typed terminal states.
- Native providers do not receive duplicated full history.

---

## Phase 7 — Parallel tools, persistent processes, and deferred discovery

### Objective

Increase throughput and tool intelligence without sacrificing deterministic model history or safety.

### Work package 7.1 — Parallel execution safety

Add per-tool concurrency classification:

```text
parallel_safe
exclusive
```

Execution rules:

- Parallel-safe tools acquire shared access.
- Exclusive tools acquire write access.
- All calls receive independent cancellation tokens.
- Completion may occur out of order.
- Model-visible results are committed in original call order.
- Each call receives exactly one terminal outcome.

Add tests for:

- Parallel reads overlap.
- A writer excludes reads and writers.
- Mixed completion order preserves model order.
- Cancellation during completion does not duplicate terminal output.

### Work package 7.2 — Persistent process sessions

Promote background shells into the tool runtime:

```text
process.start
process.poll
process.write
process.resize
process.interrupt
process.terminate
```

Persist process metadata but treat OS handles as resident state. After daemon restart, unrecoverable local processes become one classified terminal state rather than pretending they remain attached.

Bound:

- Resident process count.
- Output buffer.
- Poll cursor.
- Wall-clock lifetime.
- Idle lifetime.
- Input size.

### Work package 7.3 — Real web tools

- Execute a real configured search/fetch provider or return typed unsupported status.
- Remove placeholder “delegated” results.
- Apply network policy, URL validation, response-size limits, and provenance.

### Work package 7.4 — Deferred tool discovery

- Split always-visible core tools from deferred tools.
- Index tool name, description, namespace, capability, and keywords.
- Expose a bounded search tool that returns executable schemas.
- Cache discovery by registry version.
- Do not place every MCP schema in every model request.

MCP remains governed through the same tool orchestrator.

### Exit gate

- Independent tools execute concurrently with deterministic replay.
- Long-running commands are interactive, bounded, cancellable, and observable.
- Web tools return real data or typed failure.
- Large MCP catalogs do not inflate every prompt.

---

## Phase 8 — Rich Codex normalization and capability exposure

### Objective

Use Codex as a deep provider without leaking Codex-native shapes into Relay's core.

### Work package 8.1 — Build a notification/request coverage matrix

For every generated Codex request and notification, classify:

```text
canonical
diagnostic
provider-internal
unsupported-by-policy
```

At minimum, normalize:

- Thread start, resume, status, goal, and compaction.
- Turn start, completion, failure, steering, and interruption.
- Assistant messages and bounded reasoning summaries.
- Plan and diff updates.
- Command, file-change, MCP, and process activities.
- Approval requests and resolutions.
- Subagent lifecycle when provider-native collaboration is enabled.
- Warnings, reroutes, and capability changes.

Unknown data remains a bounded diagnostic and never crashes the adapter.

### Work package 8.2 — Expose thread capabilities through Relay

Extend Relay lifecycle with capability-gated operations:

- Fork.
- Rollback.
- Compact.
- Goal set/get/clear.
- Thread read for reconciliation.
- Persistent shell command.

Do not add a Codex-specific method to `HarnessRuntime`; use canonical operations whose unsupported result is typed.

### Work package 8.3 — Provider-native children

Choose per configuration:

- Preferred: Relay invokes its own control-plane spawn and creates a Codex thread for the child.
- If Codex internally spawns a child, immediately register its native identity and parent edge in Relay before exposing it.
- If registration cannot be guaranteed, disable native collaboration tools and use Relay spawning only.

### Work package 8.4 — Backpressure and recovery

- Bound notification queues.
- Preserve terminal notifications.
- On suspected dropped non-terminal items, reconcile through thread reads.
- Maintain per-thread routing without global listeners consuming unrelated events.

### Exit gate

- The capability matrix has no unclassified generated surface.
- Codex plan, diff, approval, compaction, process, and agent lifecycle appear as canonical Relay state.
- Dropped non-terminal notifications cannot hide terminal state.
- No provider-native child is invisible to Relay.

---

## Phase 9 — Kernel decomposition and dead-path removal

### Objective

Turn `KernelDaemon` into a small composition root and remove architectural theater.

### Target daemon structure

```text
apps/daemon/src/kernel/
  composition.ts
  command-ingress.ts
  lifecycle-supervisor.ts
  provider-session-manager.ts
  projection-publisher.ts
  convex-sync.ts
  telemetry.ts
```

The daemon wires packages and local adapters. It does not implement state machines, context policy, task scheduling, sandboxing, or provider-specific lifecycle logic.

### Work package 9.1 — Extract by ownership

Extract in this order:

1. Projection publisher.
2. Provider session manager.
3. Tool-runtime adapter registration.
4. Agent control coordination.
5. Workspace integration.
6. Lifecycle supervision.
7. Command ingress.

After each extraction:

- Move tests with the owning module.
- Add a dependency contract.
- Delete the original daemon implementation.

### Work package 9.2 — Remove disconnected modules

Integrate or delete:

- Old provider reactors/registries.
- Old context planner/manager/compaction service.
- Old workflow implementations.
- Old extension registry.
- Sandbox wrappers not used by the tool orchestrator.
- One-shot subagent adapters.
- Placeholder workspace reconciliation.

### Work package 9.3 — Strengthen durable typing

Replace durable `string` statuses and `unknown` result payloads with versioned discriminated types. Add identifiers where applicable:

- Run.
- Turn.
- Agent.
- Task.
- Activity/tool call.
- Correlation and causation.
- Provider instance.
- Native provider object.
- Schema version.

### Exit gate

- `KernelDaemon` is a composition/lifecycle module rather than the implementation of all subsystems.
- Architecture tests enforce package dependency direction.
- No test-only abstraction is described as a production capability.
- No duplicate kernel execution loop remains.

---

## Phase 10 — Production evidence, promotion, and legacy deletion

### Objective

Prove the rebuilt kernel on real seams, promote it safely, then remove legacy and temporary migration code.

### Work package 10.1 — Protected acceptance suites

Required release evidence:

1. Real Codex start, resume, turn, steer, and interrupt.
2. Two concurrent Codex runs.
3. Native approval request, daemon restart, and resolution.
4. Provider completion crash before canonical persistence.
5. Tool completion crash before canonical persistence.
6. Agent spawn race at capacity.
7. Parent restart with live children.
8. Cold child restoration and follow-up.
9. Concurrent isolated writers and integration conflict.
10. Linux/macOS/Windows sandbox readiness or fail-closed result.
11. Full escape suite.
12. Compaction followed by resume and context fork.
13. Convex outage followed by contiguous projection convergence.
14. Storage pressure and retention.
15. Backpressure with terminal-event recovery.

Run live/provider tests in protected nightly and release workflows even if they remain outside the fast local suite.

### Work package 10.2 — Operational metrics and SLOs

Record:

- Command ingress latency.
- Queue wait and execution time.
- Effect reconciliation counts and uncertainty.
- Provider first-token and total-turn latency.
- Active and resident agents.
- Spawn rejections by budget.
- Tool approval latency.
- Sandbox denial/escalation.
- Compaction frequency and compression.
- Projection lag and retry.
- Dropped/reconciled provider notification count.

No metric may include raw secrets, prompts, or unbounded tool output.

### Work package 10.3 — Shadow and kernel-default promotion

Promotion requires:

- All correctness and security gates green.
- No duplicate side-effect evidence.
- No unresolved projection divergence.
- Backup and restore rehearsal.
- Protected acceptance evidence bound to the release commit.
- At least one release window of explicit kernel operation.
- Zero unexpected legacy activations.

Shadow remains comparator-only and never executes duplicate effects.

### Work package 10.4 — Delete legacy

After promotion gates:

- Delete `apps/daemon/src/agent-loop.ts` and legacy workers/pollers.
- Delete legacy subagent and command execution paths.
- Remove `RELAY_RUNTIME_MODE=legacy|shadow|kernel` selection after the rollback window.
- Remove the kernel-disable migration kill switch when operational policy allows.
- Remove migration-only Convex reads and writes.
- Narrow schemas only after verified backup and restore.
- Preserve characterization tests only when they still validate canonical behavior; otherwise delete them with the code.

### Final acceptance gate

The rebuild is complete only when:

- Kernel is the default and sole execution authority.
- Legacy execution code is absent.
- Every external effect is execute-once plus reconcile.
- Every governed tool uses the central orchestrator and real sandbox.
- Provider sessions are per agent and concurrently usable.
- Subagents are durable agents with tools, mailboxes, budgets, and workspaces.
- Raw-provider context survives restart and compaction.
- Native-provider lifecycle is normalized without duplicating native history.
- Protected release evidence is green for the exact release commit.

---

## Canonical event and command migration

Use widen-migrate-narrow.

### Widen

Add optional identifiers and new event variants:

```text
agent.*
task.*
tool.*
process.*
context.compaction.*
effect.outcome_unknown
workspace.integration.*
```

Add new tables and codecs without changing current readers.

### Migrate

- Dual-project new canonical events into views while old views remain readable.
- Backfill only metadata that can be derived without inventing history.
- Do not synthesize fake provider-native IDs for older runs.
- Mark imported or unavailable values explicitly.

### Read cutover

- Browser and diagnostics consume new canonical projections.
- Old Convex reads remain only behind the rollback boundary.

### Narrow

- Remove old columns, tables, and queries only after release evidence and backup rehearsal.
- Narrowing is a separate reviewed change from runtime promotion.

## Test strategy

### Unit

- Reducers and validators.
- Capability intersections.
- Scheduler readiness.
- Context history invariants.
- Tool concurrency classification.
- Provider normalization tables.

### Integration

- SQLite transactions, leases, and migrations.
- Effect operation journal.
- Provider registry restart.
- Mailbox ordering.
- Workspace ownership and integration.
- Compaction and resume.
- Process lifecycle.

### Fault injection

- Every dispatch/persist boundary.
- Lease loss during result persistence.
- Provider disconnect.
- Projection sink outage.
- Daemon restart with active agents and processes.
- Backpressure and queue closure.

### Protected end-to-end

- Real Codex.
- Real supported OS sandboxes.
- Authenticated Convex ingress/projection.
- Release backup/restore.

## Verification ladder for each phase

Run the narrowest focused suite first, followed by:

```bash
bun run typecheck
bun run test
bun run build
bun run security:gate
bun run bundle:check
bun run codex:schema:check
bun run conformance:matrix
bun run crash:matrix
bun run test:e2e:harness
```

When applicable:

```bash
bun run codex:harness:smoke
bun run eval:harness
bun run canary:evidence
bun run release:evidence
```

## Commit and review boundaries

Prefer one reviewable change per work package. Never combine:

- Schema narrowing with behavior changes.
- Provider-session migration with agent-control migration.
- Sandbox enforcement with new tool capability.
- Context compiler cutover with compaction policy changes.
- Kernel-default promotion with legacy deletion.

Every phase closes with:

1. Focused tests.
2. Full verification ladder.
3. Recorded evidence.
4. Deletion of replaced code within that phase.
5. An explicit go/no-go review for the next phase.

## First implementation slice

Begin with Phase 0 and Phase 1 only.

The first review-sized sequence is:

1. Add kill-point characterization for provider turn dispatch and result persistence.
2. Add `external_operations` migration and store tests.
3. Refine the reactor contract around prepare/execute/reconcile.
4. Convert `provider.send_turn`.
5. Prove restart recovery cannot dispatch a second provider turn.
6. Convert approval resolution and checkpoint capture.
7. Run the full crash matrix and verification ladder.

Do not start the agent-control implementation until execute-once recovery is proven. A durable agent tree built on repeatable external effects would make failures more numerous rather than more recoverable.
