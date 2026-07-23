# Kernel-mode capability gaps vs. legacy

**Status:** Open tracked follow-up, discovered 2026-07-23 while proving the
real cross-tier recovery seam (`tickets.md`, "Close kernel turn capability
gaps"). Governed tool execution and durable approval suspension/resolution
are now complete; provider continuation with tool results, true in-flight
steering/interrupt cancellation, and automatic checkpoint capture remain open.
Later tickets that assume kernel-mode parity with legacy
("Prove shadow parity," "Cut the browser over," "Canary kernel default,"
"Remove legacy execution paths") must not proceed on a false premise.

## What's missing

Kernel mode's turn execution (`apps/daemon/src/kernel-daemon.ts`,
`executeTurn()`) now consumes provider tool calls after the provider stream,
but the capability is intentionally incomplete. Concretely, in kernel mode
today:

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
- **Provider continuation with tool results is still absent.** The current
  provider bridge consumes tool calls after the provider stream; it does not
  resume the provider with the resulting tool output.
- **`provider.steer_turn`, `provider.interrupt_turn`, `tool.execute`, and
  `checkpoint.capture` effect reactors remain no-ops** (`kernel-daemon.ts`,
  the `noopReactor` registration loop). Their canonical commands/events exist
  and update run state correctly, but the corresponding real work never
  happens.
- **`turn.interrupt` doesn't abort an in-flight provider call.**
  `executeTurn()` uses a fixed `AbortSignal.timeout(10 * 60 * 1000)`, never
  connected to the interrupt command or effect cancellation. Interrupting
  records `turn.interrupted` state but the streaming call keeps running.
- **No per-turn auto-checkpoint.** `checkpoint.capture` is a no-op; only
  the explicit `checkpoint.restore`/`checkpoint.compare` commands (against
  checkpoints created some other way) function.

## Completed increment — governed tool execution

The kernel tool bridge is covered by `apps/daemon/src/kernel-daemon.wiring.test.ts`
with a real temporary workspace: an allowed edit changes the file and records
an allow audit decision; a denied high-risk shell command produces no file
effect and records a deny decision. Both cases emit canonical activity events
before `turn.completed`.

This does not yet make the provider loop fully agentic: tool calls are
consumed after the current provider stream, and the provider is not resumed
with tool results. That remains deliberate follow-up work rather than a
hidden parity claim.

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

## Confirmed live (2026-07-23): mid-turn steering cannot be delivered today

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

`turn.steer`, `turn.interrupt`, and `approval.resolve` are three of the ten
command kinds `convex/commands/inbox.ts` accepts at ingress
(`SUPPORTED_COMMAND_KINDS`), but `KernelDaemon.processCommand`'s dispatch
switch had no case for any of them — they fell through to `default` and
were rejected as "unknown command kind." Added the three missing cases,
wired to the already-implemented `LocalHarnessRuntime.steerTurn`/
`interruptTurn`/`resolveApproval`. This makes the *commands* route and
update canonical state correctly; it does not create the underlying
tool-execution/governance capability described above.

## Why this matters for later tickets

- **"Prove shadow parity without duplicate effects"**: shadow mode compares
  kernel decisions against legacy on the same inputs. Inputs that exercise
  provider continuation, mid-turn steering, or a checkpoint will diverge by
  construction until those gaps close — not a shadow-mode bug to chase.
- **"Cut the browser over" / "Canary kernel default"**: cutting real users
  onto kernel mode today would silently drop tool use, governance, and
  auto-checkpointing relative to legacy. This is a functional regression,
  not just a migration risk, and should block canary promotion regardless
  of what the canary telemetry shows.

## Scope decision (2026-07-23)

Per explicit direction: "Prove the real cross-tier recovery seam" is scoped
to what kernel mode *actually does today* — create/resume/send/streaming,
steer/interrupt as canonical state transitions (not real cancellation),
durable approval suspension/resolution, checkpoint.restore/compare,
projection/reconnect/restart, and fault injection against those. This gap is tracked here as a
separate, later piece of work — likely comparable in size to porting
`governed-tool-executor.ts`/`turn-loop.ts`'s capability into the kernel
effect-reactor model — not bundled into the seam-proving ticket.
