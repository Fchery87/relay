# Kernel turn capability gaps implementation plan

## Goal

Close the kernel-mode turn-loop gaps that block shadow parity: provider
continuation after tool results, durable approval resumption, real steering and
interrupt cancellation, and orchestration-owned checkpoint capture.

## Design

1. Reuse `TurnModelProvider` and `runAgenticTurn` as the provider seam. The
   kernel adapter will emit canonical assistant/activity/usage events while
   the existing provider adapters receive the complete message history,
   including tool results, on every iteration.
2. Treat an approval as a durable suspension, not a completed turn. The
   continuation stores only validated, provider-neutral chat messages plus the
   held tool call and tool-use ID. Approval resolution executes the tool and
   resumes the same agentic loop through the configured turn provider.
3. Decouple command completion from long-running effect draining. The daemon
   must return the `turn.send` command receipt after queuing its durable effect,
   allowing later steer/interrupt commands to be claimed while the provider is
   still streaming.
4. Keep active provider abort controllers keyed by run and turn. The
   interrupt reactor aborts the matching controller; stale or terminal provider
   output is ignored by the canonical decider and cannot reopen a turn.
5. Capture a checkpoint through the kernel's idempotent hidden-ref checkpoint
   helper (the workspace-runtime `CheckpointManager` remains the durable
   metadata authority for the separate workspace ticket)
   and git checkpoint adapter at the turn boundary. The resulting
   `checkpoint.captured` event is emitted only once for a given run/turn.

## Implementation order

1. Add RED tests for agentic provider continuation and approval suspension.
2. Add RED tests proving a daemon can accept steer/interrupt while a provider
   effect is held in flight.
3. Add RED tests for idempotent before/after checkpoint capture and its
   canonical event.
4. Implement the loop/adapter/runtime wiring in small commits.
5. Run focused daemon/orchestration/workspace tests, then the full test,
   typecheck, build, security, and bundle checks.

## Non-goals

This plan does not yet change the separately tracked secret-argv limitation,
hosted migration policy, browser cutover, canary rollout, or legacy-path
removal tickets. Those remain gated on this parity work.
