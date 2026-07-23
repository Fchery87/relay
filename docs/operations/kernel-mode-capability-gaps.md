# Kernel-mode capability gaps vs. legacy

**Status:** Open finding, discovered 2026-07-23 while proving the real
cross-tier recovery seam (`tickets.md`, "Prove the real cross-tier recovery
seam"). Not yet its own tracked ticket in either ticket group — recorded
here so it isn't lost, and so later tickets that assume kernel-mode parity
with legacy ("Prove shadow parity," "Cut the browser over," "Canary kernel
default," "Remove legacy execution paths") don't proceed on a false premise.

## What's missing

Kernel mode's turn execution (`apps/daemon/src/kernel-daemon.ts`,
`executeTurn()`) only handles `assistant.delta` and `usage.recorded`
provider stream events. Concretely, in kernel mode today:

- **No tool execution.** `executeTurn()` never calls `provider.toolCalls()`
  and never invokes `governed-tool-executor.ts`'s `executeGovernedToolCall`
  (imported for its `GovernanceGateway` type only, never called). No file
  reads/edits, no shell commands, during a `turn.send`.
- **No governance chokepoint or approval cards during a turn.** Nothing
  produces a real `approval_required` state from tool risk classification.
  `approval.resolve` (now wired at command-dispatch — see below) can only
  resolve an approval that something else created, and nothing creates one.
- **`provider.steer_turn`, `provider.interrupt_turn`,
  `provider.resolve_approval`, `tool.execute`, and `checkpoint.capture`
  effect reactors are all registered as no-ops** (`kernel-daemon.ts`, the
  `noopReactor` registration loop). Their canonical commands/events exist
  and update run state correctly, but the corresponding real work never
  happens.
- **`turn.interrupt` doesn't abort an in-flight provider call.**
  `executeTurn()` uses a fixed `AbortSignal.timeout(10 * 60 * 1000)`, never
  connected to the interrupt command or effect cancellation. Interrupting
  records `turn.interrupted` state but the streaming call keeps running.
- **No per-turn auto-checkpoint.** `checkpoint.capture` is a no-op; only
  the explicit `checkpoint.restore`/`checkpoint.compare` commands (against
  checkpoints created some other way) function.

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
  kernel decisions against legacy on the same inputs. Any input that
  exercises a tool call, an approval, or a mid-turn checkpoint will diverge
  by construction until this gap closes — not a shadow-mode bug to chase.
- **"Cut the browser over" / "Canary kernel default"**: cutting real users
  onto kernel mode today would silently drop tool use, governance, and
  auto-checkpointing relative to legacy. This is a functional regression,
  not just a migration risk, and should block canary promotion regardless
  of what the canary telemetry shows.

## Scope decision (2026-07-23)

Per explicit direction: "Prove the real cross-tier recovery seam" is scoped
to what kernel mode *actually does today* — create/resume/send/streaming,
steer/interrupt/approval as canonical state transitions (not real
cancellation/gating), checkpoint.restore/compare, projection/reconnect/
restart, and fault injection against those. This gap is tracked here as a
separate, later piece of work — likely comparable in size to porting
`governed-tool-executor.ts`/`turn-loop.ts`'s capability into the kernel
effect-reactor model — not bundled into the seam-proving ticket.
