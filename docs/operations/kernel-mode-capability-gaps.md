# Kernel-mode capability gaps vs. legacy

**Status:** Closed for the kernel turn-loop scope on 2026-07-23. The gap was
discovered while proving the real cross-tier recovery seam (`tickets.md`,
"Close kernel turn capability gaps"). Governed tool execution, durable
approval suspension/resolution, provider continuation with tool results,
in-flight steering/interrupt cancellation, and automatic checkpoint capture
are now covered by the durable kernel path and focused regressions.
Later tickets that assume kernel-mode parity with legacy
("Prove shadow parity," "Cut the browser over," "Canary kernel default,"
"Remove legacy execution paths") must not proceed on a false premise.

## Historical gap (now closed)

The following findings described the kernel behavior at discovery time:

- **Governed tool execution.** `executeTurn()`
  calls `provider.toolCalls()` when available and routes calls through
  `executeGovernedToolCall`, the configured policy, governance audit, and
  sandbox/tool executor using the authorized project path carried by the
  canonical command claim. It emits `activity.started`, bounded
  `activity.delta`, `activity.completed`, or `activity.failed` events. The
  policy `allow`/`deny` decisions execute or refuse through the sandbox; an
  `ask` decision creates a durable Convex approval containing a private,
  device-readable continuation and emits `approval.requested` without
  blocking the daemon poller.
- Provider continuation, control-effect routing, interrupt cancellation, and
  automatic checkpoints were absent at discovery time. The implementation now
  lives in `kernel-agentic-turn.ts`, the live control-effect lane in the
  orchestration engine, and the kernel provider reactor.

## Completed increment — governed tool execution

The kernel tool bridge is covered by `apps/daemon/src/kernel-daemon.wiring.test.ts`
with a real temporary workspace: an allowed edit changes the file and records
an allow audit decision; a denied high-risk shell command produces no file
effect and records a deny decision. Both cases emit canonical activity events
before `turn.completed`.

The provider loop now resumes through the provider adapters with the complete
provider-neutral message history, including tool results.

The daemon now supplies the active MCP catalog to the kernel provider turn and
routes MCP calls through the configured `McpRegistry` callback. Task calls use
the existing governed subagent adapter and append the subagent's bounded
canonical activity events before returning its typed result to the provider.
MCP task-status callbacks still use the legacy conversation gateway; MCP
elicitation cards now derive their lifecycle from canonical activity events,
with submit/cancel entering through canonical inbox commands and the
device-authorized daemon adapter. The task-status callback remains a separate
cutover item, not a reason to bypass governance.
The browser inspector derives subagent runs from the canonical activity tail,
so the subagent detail surface no longer needs the legacy tree query in
projection mode.

Kernel run creation also publishes the trusted built-in, user, and project
slash-command catalog as a bounded configuration event. The composer consumes
that event in projection mode, so slash discovery no longer needs its legacy
Convex query during cutover.

## Completed increment — durable approval suspension and resolution

An `ask` policy decision now inserts a Convex approval with its continuation
private to the device-scoped query, emits `approval.requested`, and returns
without waiting inside the serialized daemon poller. A matching
`approval.resolve` is handled by a real `provider.resolve_approval` reactor:
the reactor verifies run identity, resolution, turn identity, and workspace
authority before resuming the held tool through the same governed executor.
The decider then appends `approval.resolved` and the matching `turn.completed`
in canonical order. Focused daemon, orchestration, and Convex tests cover
allow, deny, private continuation visibility, and stale identity rejection.

## Completed increment — agentic continuation and live controls

`TurnModelProvider` and the shared agentic loop now receive tool results on
subsequent provider requests. Approval continuations persist the held call,
tool-use ID, and validated message history; resolution executes the tool and
re-enters the provider loop. `turn.send` no longer blocks the command poller,
and a dedicated control-effect lane delivers steering at a stream boundary or
aborts the active provider signal for interrupts. Focused tests cover the
continuation and a real `KernelDaemon` control path.

## Completed increment — orchestration-owned checkpoints

The kernel provider reactor captures a deterministic hidden Git checkpoint
before and after a turn when an authorized workspace is present. Ref and
event IDs are deterministic, so retries converge without duplicate projected
events. The daemon regression test verifies both canonical checkpoint events.

## Confirmed live before the fix (2026-07-23; retained as evidence)

Proven via `apps/daemon/src/cross-tier-recovery.e2e.test.ts` against the
real seam, not just reasoning about the code: `KernelDaemon.poll()` claims
a bounded batch and processes each command sequentially inside one `for`
loop (`processCommand` is `await`ed per command), and a new `poll()` tick
is a no-op while one is already in flight (`pollInFlight` guard). A
`turn.steer` submitted right after `turn.send` is therefore never looked
at until the current turn's `processCommand` call returns — by which point
the turn has already reached a terminal state (with the scripted provider,
near-instantly; with any real provider, whenever that response finishes).
`decider.ts` correctly rejects late steering (`"Cannot steer a run without
an active turn"`) rather than corrupting state, so this fails safe, but it
means **steering a genuinely in-progress turn is not just missing
governance — it's structurally unreachable in the current architecture**,
independent of the tool-execution gap above. Fixing it needs either
per-run concurrent processing or `executeTurn` polling for queued steering
between stream events, not just a reactor wire-up.

Similarly, `approval.resolve` is gated by `decider.ts` to the
`awaiting_approval` status only (stricter than `state.ts`'s reducer, which
has a separate no-op branch for *replaying* an already-applied
`approval.resolved` event — a different code path, not a live safety net
for resolving a nonexistent approval). Confirmed live: resolving with no
pending approval is correctly rejected, not silently accepted.

## What was fixed alongside this finding (2026-07-23)

The command dispatch now routes all three command kinds and the control
effects are drained concurrently with the provider effect. The original
unknown-command and serialized-poller findings remain here as historical
evidence of the regression that the new tests protect against.

## Why this matters for later tickets

- Shadow parity may now compare continuation, control, governance, and
  checkpoint behavior; its own no-duplicate-effect evidence is still required.
- Browser cutover and canary promotion remain gated by their independent
  projection, rollout, and release-window tickets.

## Scope decision (2026-07-23)

Per explicit direction, the original cross-tier seam was scoped to the
behavior kernel mode actually had at that point. The follow-up is now closed:
the kernel effect path owns the agentic provider loop, control-effect lane,
durable approval continuation, and before/after checkpoint capture. Shadow
parity and browser/canary work may proceed only after their remaining
independent gates are satisfied.
