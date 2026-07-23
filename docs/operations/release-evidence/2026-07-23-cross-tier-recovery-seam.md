# Evidence — cross-tier recovery seam, first live proof

Records the first live exercise of `apps/daemon/src/cross-tier-recovery.e2e.test.ts`
against a real, isolated, throwaway self-hosted Convex backend — see
[backup-recovery.md](../backup-recovery.md) for the general evidence format
and [2026-07-23-baseline.md](2026-07-23-baseline.md) for the prior snapshot.

## What this proves

A real client command (submitted the way the browser will once cut over —
see `apps/web/src/run-data.ts`'s `submitCanonicalCommand`, not yet wired to
a caller) travels through the real `commands/inbox:submitToInbox` mutation,
is claimed by a real `KernelDaemon` via the real `createConvexCommandSource`,
processed through the real local orchestration engine, and published back
to Convex via the real `createConvexProjectionSink` — with **no fakes and
no `convex-test` simulator anywhere in the path**. Covers: `run.create`,
`run.resume`, `turn.send` with streaming (scripted/fallback provider),
projection landing with a contiguous no-gap event sequence, a reconnecting
client resuming from a mid-stream cursor without gaps or duplicates, and a
daemon restart (fresh `KernelDaemon` instance, same local SQLite, same
backend) converging without duplicating the `run.create` effect.

The remaining live additions cover a real temporary Git project wired through
the daemon's project-root adapter and explicit checkpoint restore, a command
mutation whose committed response is deliberately discarded before an exact
retry, and the production projection sink's exact-duplicate, reordered, and
partial-batch behavior against the real Convex server.

## Update — 2026-07-23: side-effect-safe shadow runtime

Shadow mode now has an application runtime at
`apps/daemon/src/shadow/shadow-runtime.ts` and a projection comparator at
`apps/daemon/src/shadow/projection-comparator.ts`. The real legacy conversation
gateway is wrapped at its claim/message/turn boundary; the wrapper records
normalized canonical input and legacy-owned effect identities. Shadow replays
that input through a deterministic local provider adapter with no workspace,
tool, checkpoint, or remote projection effects. `apps/daemon/src/index.ts`
starts no `KernelDaemon` and no second claim loop in shadow mode.

Parity evidence is persisted as JSONL under the daemon home, reloaded on
restart, and exposes a promotion-blocking flag for unexplained divergence.
The comparator covers canonical lifecycle, provider-session, turn, assistant,
activity, approval, usage, checkpoint, and projection events plus durable
snapshot state. Formatting normalization is available only through the
explicit `assistant.delta.formatting` allowlist. The focused shadow suite
passes with 10 tests across the orchestration comparator and daemon runtime,
including gateway capture, duplicate timer prevention, effect fencing,
restart hydration, and divergence blocking.

This proves the deterministic side-effect-safe shadow seam. It does not turn
the protected real Codex harness into ordinary CI, and the real-provider
checkpoint/file-edit/restart gate remains required before canary promotion.

## Update — 2026-07-23: reversible browser canonical boundary

The browser now has an explicit `VITE_RELAY_PROJECTION_ENABLED=1` cutover
flag. When enabled, run discovery reads projection summaries, core create,
turn, stop, approval, and checkpoint-restore actions submit stable canonical
inbox envelopes, and `useProjectionRun` decodes projection snapshots/events
through `ClientRuntime`. Confirmed cursors are persisted in browser storage;
snapshot regression and sequence gaps visibly fail closed. The legacy boundary
remains the default rollback path.

Focused client/browser verification passes the canonical runtime, checkpoint,
and client-runtime suites, including canonical ID
stability, snapshot reduction, cursor confirmation, reconnect, terminal
handling, gap failure, ordered message projection, checkpoint metadata, and
canonical checkpoint comparison, bounded current-worktree diff projection, and
canonical review-comment creation/resolution projection. Git stage/commit/push
controls now use the same canonical command boundary and project bounded
`git.action.updated` lifecycle events.
Run model, thinking level, permission profile, and usage budget controls now use the
same `run.configure` inbox command and `run.configuration.updated` projection event;
the browser reads those settings from the projected snapshot when the cutover flag is enabled.
Projection-backed messages, activity, approvals, audit, usage, checkpoints, comparison,
and Git panels no longer issue redundant legacy Convex reads while the cutover flag is enabled.
Canonical run creation also preserves the run title and chat/plan mode in the projected snapshot,
so projected discovery no longer invents a generic title or defaults every run to chat.
Projection read authorization now has direct Convex coverage: a second owner
cannot read another owner's snapshot, event stream, run list, or cursor, and
canonical command ingress rejects another owner's thread. Full detail-panel
migration and end-to-end browser behavior coverage remain open before this flag
can be promoted beyond canary. Plan artifacts now derive from the canonical
`plan.updated` event: planning emits a revisioned draft, browser edits and
approval enter through canonical commands, and the approved artifact drives the
build phase. Slash-command discovery now derives its bounded
catalog from a canonical run-configuration event emitted during kernel run
creation. MCP elicitation cards now derive pending/submitted/cancelled state
from canonical `activity.*` events, while submit/cancel enter through
canonical inbox commands and the
device-authorized daemon adapter. The projected inspector also derives
subagent runs from canonical `activity.*` events, including role, task, status,
and a bounded result summary, so those detail surfaces no longer issue legacy
reads or writes during cutover. The projection hook also uses a bounded event tail, so
historical comments outside that tail require a follow-up pagination/compaction
design.
Kernel MCP task-status callbacks are also canonical: task progress is emitted
as bounded activity lifecycle events and no longer uses the legacy task-status
write in kernel mode.

## Two real, previously-undetected bugs found and fixed

Both existed in code shipped and "complete" per prior sessions' ticket
checkmarks — neither was ever caught because prior tests exercised these
code paths only through fakes, never over a real network round-trip:

1. **`convex-command-source.ts` / `convex-projection-sink.ts`**: their
   `fetchMutation` helper read `(ref as { _name: string })._name` to get a
   Convex function's dotted path from a `FunctionReference` — but
   `makeFunctionReference()` stores the name under an internal symbol, not
   a `_name` property. Every real call from these two files sent
   `path: undefined` to Convex, which rejected it as `BadJsonBody`. This
   means **the kernel daemon's real command-claim loop and real projection
   publish loop had never successfully executed a single RPC against a
   real backend**, despite `claimBatch`/`completeCommand`/`renewLease`/
   `appendEvents`/`upsertSnapshot`/`advanceCursor` all being individually
   unit-tested against fakes. Fixed by switching to the official
   `getFunctionName()` export from `convex/server`.
2. **`run.create` didn't preserve the canonical run ID.** `submitToInbox`
   assigns a canonical run ID (defaulting to the thread ID) to every
   command, but `KernelDaemon`'s `run.create` handler called
   `runtime.createRun({ projectId })` without it, and
   `OrchestrationEngine.createRun` always generated a fresh random ID.
   A `run.resume`/`turn.send` referencing the canonical ID could never
   find the locally-created run (`run_not_found`). This directly
   contradicts the "one canonical run ID survives every tier" invariant
   already marked done under "Expand to one canonical command and run
   identity" — that ticket's own tests never drove a real `run.create`
   through the real command inbox, only through direct `HarnessRuntime`
   calls that don't go through `submitToInbox` at all. Fixed by adding an
   optional `runId` to `CreateRunInput`/`OrchestrationEngine.createRun`
   and threading the command's canonical `runId` through in
   `KernelDaemon.processCommand`'s `run.create` case.

## Versions and topology

- Commit: (recorded at commit time in the accompanying git history)
- Backend: pinned per
  [self-hosted-convex-pin.json](../self-hosted-convex-pin.json), started
  fresh/isolated per test run (not the pinned dev instance — a throwaway
  instance built the same way, from the same installed binary)
- Topology: D1/D2/D3 per [ADR 0005](../../adr/0005-convex-production-topology.md)
  and [convex-history-migration-decision.md](../convex-history-migration-decision.md)
  — local development only, no live production

## Residual risks / not yet covered (as of 2026-07-23)

- The kernel tool bridge is covered by focused tests: provider tool calls pass
  through policy/governance/sandbox execution and emit canonical activity
  events. Durable approval suspension/resolution now creates a private
  continuation, releases the serialized poller, and resumes only for the
  matching run/turn/resolution. The kernel daemon now passes the active MCP
  catalog to provider turns, routes MCP calls through `McpRegistry`, and
  routes task calls through the governed subagent adapter with canonical
  activity events. MCP elicitation and task-status callbacks now also emit
  canonical activity lifecycle events; remaining browser detail-surface
  parity is still pending its own projection coverage.
- A real LLM provider (as opposed to the scripted/fallback provider) has not
  produced a passing lifecycle record in this environment. The separate
  protected `real-codex-harness` job exists in `.github/workflows/ci.yml`, but
  the gate remains unverified until that job records a passing run.
- A local protected harness attempt reached the installed Codex app-server but
  could not complete `initialize`: the execution environment denied the
  provider's HTTPS request and no `OPENAI_API_KEY` was available. This is
  recorded as an unverified gate, not as provider parity evidence.

## Update — 2026-07-23: protected Codex harness slice

The real-provider seam now has an explicit opt-in daemon-level harness test at
`apps/daemon/src/codex-harness.e2e.test.ts` and a protected runner at
`scripts/smoke-codex-harness.ts`. It uses a temporary Git workspace, the
persistent local SQLite runtime, canonical projection events, and a second
daemon instance for native-thread resume. Ordinary CI skips it; manual CI
installs the pinned Codex app-server and supplies `OPENAI_API_KEY` only to the
local child process.

The provider adapter also accepts the current `thread/started`,
`item/agentMessage/delta`, and command/file item lifecycle shapes. Kernel Codex
turns carry the resolved workspace cwd and persist the before/after checkpoint
around the terminal event, with deterministic ordering coverage in
`kernel-daemon.wiring.test.ts`.

The protected end-to-end harness remains an explicit release gate: this
environment completed the current-provider basic turn smoke, but the full
file-edit/restart lifecycle was not re-run after the final checkpoint-ordering
fix because the protected credential-bearing rerun was rejected by the
execution boundary. The harness now creates and cleans a writable temporary
`CODEX_HOME` for protected runs, so CI does not inherit a read-only agent home;
the cross-tier ticket nevertheless remains unchecked until a manual protected
run with `OPENAI_API_KEY` records a passing result.
- The scoped checkpoint proof exercises explicit `checkpoint.restore` against
  a real temporary Git project. `checkpoint.capture` remains a no-op in kernel
  mode and is intentionally excluded with the capability gap above.

## Update — 2026-07-23: three more real bugs, most of the fault-injection matrix

Continuing the same test file, still against a real isolated backend:

**More bugs found and fixed:**

3. `turn.steer`, `turn.interrupt`, and `approval.resolve` — three of the ten
   command kinds `commands/inbox.ts` accepts at ingress — had no case at
   all in `KernelDaemon.processCommand`'s dispatch switch. Every one fell
   through to `default` and was silently rejected as "unknown command
   kind." Fixed by wiring the three missing cases to the already-
   implemented `LocalHarnessRuntime.steerTurn`/`interruptTurn`/
   `resolveApproval`.
4. `commands/inbox:submitToInbox`'s duplicate-commandId conflict check
   compared `kind`/`runId`/`correlationId` but not `payloadJson` — so
   resubmitting the same `commandId` with a genuinely different payload
   silently returned the original receipt instead of being rejected as
   conflicting, violating the documented "changed immutable fields are
   rejected" invariant. Fixed by including `payloadJson` in the check.

**Earlier major finding (now partly closed; see [kernel-mode-capability-gaps.md](../kernel-mode-capability-gaps.md)):**
kernel mode's turn loop (`executeTurn()`) only handles text/usage stream
events. At the time of this finding it did not call tool execution or
`governed-tool-executor.ts`, and the approval reactor was a no-op. The tool
bridge and durable approval suspension/resolution are now covered by the
focused capability increment below. Kernel mode still cannot actually cancel
an in-flight provider call on interrupt or auto-checkpoint per turn — despite
the corresponding v1 tickets being marked done (true for the legacy runtime
only). Also proven
live: mid-turn steering is structurally unreachable regardless of this gap,
because `KernelDaemon.poll()` claims and processes a batch strictly
sequentially, so a `turn.steer` submitted after `turn.send` is never looked
at until the turn has already reached a terminal state. Per explicit
direction, this is tracked as separate follow-up work, not blocking this
ticket — the seam-proving tests below cover the command-routing and
precondition-rejection behavior that exists today, not full semantics.

**Fault-injection matrix — all requested recovery transport cases are now
covered against the real seam:** duplicate/conflicting commands, lease-expiry
redelivery, stale-worker fencing (lease-generation gated), daemon restart,
backend process restart, a committed-but-lost command response, and real
projection duplicate/reorder/partial publication all converge or fail closed
as expected. The production Convex source/sink now parse HTTP-200 error
envelopes, which the real projection fault test exposed.

Test count: 9 → 12 passing tests in
`apps/daemon/src/cross-tier-recovery.e2e.test.ts` (all live, with the focused
additions run against the isolated backend; the full file remains the
protected live profile).

## Update — 2026-07-23: kernel capability increments

`apps/daemon/src/kernel-daemon.wiring.test.ts` now proves the first tracked
capability-gap increment with a real temporary workspace. An allowed provider
edit changes the workspace and emits `activity.started`/`activity.completed`
canonical events; a denied high-risk shell command records the deny decision,
does not touch the workspace, and emits the same canonical activity lifecycle.
Convex ingress binds the command's project path to the authorized thread's
project path and returns that authorized path with the daemon claim, so the
daemon does not mistake a Convex project document ID for a filesystem
repository or accept a caller-selected workspace.

Policy `ask` now creates a durable Convex approval with a device-private
continuation and emits `approval.requested` without blocking the serialized
poller. A matching `approval.resolve` runs through the real
`provider.resolve_approval` reactor, verifies the run/turn/resolution identity,
executes or refuses the held tool, and allows the decider to append
`approval.resolved` followed by `turn.completed`. Focused daemon, orchestration,
and Convex tests cover the allow/deny paths and private continuation boundary.

Provider continuation with tool results, true in-flight steering/interrupt
cancellation, and orchestration-owned checkpoint capture remain open and
continue to block parity claims for those behaviors.

## Update — 2026-07-23: kernel capability-gap closure

The preceding residual-risk paragraph is historical. Commit `f79fb2b`
implemented and verified the kernel turn-loop follow-up: provider-neutral
continuation after tool results, durable approval suspension/resolution,
concurrent steering and interrupt control effects, and automatic before/after
hidden Git checkpoints with retry-idempotent refs. Focused daemon and
orchestration regressions plus the full repository gates pass.

The remaining provider risk is intentionally separate: this evidence still
does not claim a real Codex/LLM turn. The protected cross-tier job currently
proves the real isolated backend with deterministic effects; the real-provider
vertical slice must pass before shadow parity or canary claims are promoted.

## Update — 2026-07-23: canary telemetry and rollback readiness

Kernel canary telemetry now crosses the daemon boundary through the machine
heartbeat and is stored separately from the high-churn machine presence row.
The bounded record covers leases, duplicate commands, pending effects,
projection backlog/gaps/divergence, auth, sandbox, recoverable/unrecoverable
failures, and provider fallback activations. A projection gap/divergence,
sandbox violation, or unrecoverable failure writes a redacted
`kernel-canary-rollback.json` marker and stops kernel processing; the documented
legacy restart path remains available. This closes the code-readiness portion
of the canary ticket. Actual developer/internal/production canary stages,
real-provider evidence, parity observation, and the release window remain
operational gates.
The machine-readable companion command is `bun run canary:evidence`; it writes
the stage record with versions, topology, migration state, test IDs, explicitly
redacted failures/logs, residual risks, and promotion-blocking telemetry status.
Pass the machine-readable telemetry snapshot with `--telemetry <path>` and
optional redacted log lines with `--log <text>`. Records with missing required
facts, missing telemetry, failures, duplicate/cross-owner results, or invariant
telemetry are promotion-blocking and are written with `0600` permissions. When
given a previous record it first requires that record to be complete and
unblocked, then enforces the developer → internal → small-production →
kernel-default progression. This makes the local evidence gate fail closed; it
does not substitute for the credentialed real-provider run or the supervised
release window.

Ordinary CI validation is deterministic: the current daemon suite recorded
344 passing tests, one credential-dependent skip, and zero failures.
The live self-hosted Convex and MCP transport profiles remain protected and
are run separately when loopback/process capabilities and, for Convex, the
pinned backend binary are available.

## Update — 2026-07-23: current-tree operational closure

Commit `e97fb22` passed the protected isolated-backend seam with 12/12 tests
and 47 assertions. The run covered ordered projection reconnect, daemon and
backend restart, duplicate/conflicting commands, lost response, lease expiry,
stale completion fencing, projection duplicate/reorder/partial faults, and a
real Git checkpoint restore.

The same commit's local-store operational gap is now implemented:
`relay diagnostics export` produces a bounded, anonymized, payload-free state
dump; retention requires a hash-verified history snapshot before pruning
canonical events; checkpoint metadata is only collectible after explicit
Git-ref cleanup marking; and filesystem pressure pauses new kernel command
claims while retaining the recovery reserve.

The real Codex provider lifecycle remains unverified because this environment
has no credentialed provider secret. Canary promotion, a complete legacy
rollback window, and schema narrowing therefore remain release-gated rather
than inferred from this deterministic/provider-independent evidence.
