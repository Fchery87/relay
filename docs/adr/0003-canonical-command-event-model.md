# ADR 0003: Canonical Command and Event Model

**Status:** Accepted  
**Date:** 2026-07-15  

## Context

Relay v1 has no explicit event or command model. The daemon mutates Convex documents directly (messages, events, diffs, approvals, auditLog) from scattered worker functions (`agent-loop.ts`, `command-worker.ts`, `git-worker.ts`, `checkpoint-worker.ts`, `subagent-worker.ts`, `checkpoint-comparison-worker.ts`). Each worker has its own claim-and-update pattern with no shared ordering, idempotency, or replay contract. Provider-specific shapes (notification names, tool-call payloads, usage structures) leak through the thin `ModelProvider` interface into the daemon's core.

This makes it impossible to:
- Prove ordering and idempotency across work types.
- Resume from a known sequence after a crash or reconnect.
- Swap providers without leaking one provider's shapes into the system.
- Reason about system state as a state machine with known transitions.

A decision is needed on the canonical shape of commands, events, and state transitions.

## Decision

**Adopt an append-only canonical event model with a pure run-state reducer, and a typed command envelope with exactly-once semantics.**

- **Every accepted command** (external: create/resume/send/steer/interrupt/approve/stop/restore; internal: provider events, workspace results, checkpoint results, projection acknowledgements) is wrapped in a `CommandEnvelope` with a globally unique `commandId`, a typed `actor` ("user" | "device" | "provider" | "system"), and an optional `expectedStreamVersion` for optimistic concurrency.
- **A pure `reduceRun(state, event)` reducer** is the only function that defines run-status semantics. It accepts an immutable `RunSnapshot` and a parsed command and returns `{ events, effects }` — canonical events to append plus side-effect intents to dispatch. It performs no I/O and is the only code path allowed to change run status.
- **Canonical events are append-only with a strictly increasing per-run `sequence`.** Every accepted command produces zero or more ordered events in the same local transaction as its receipt and projection updates. Provider-native events are normalized at the adapter seam; unknown notifications become bounded diagnostic records, never crashes. The canonical event union is:

  ```
  run.created | run.started | run.stopping | run.stopped | run.failed
  provider.session.started | provider.session.resumed | provider.session.stopped
  turn.started | turn.steered | turn.completed | turn.failed | turn.interrupted
  assistant.delta | assistant.completed
  activity.started | activity.delta | activity.completed | activity.failed
  approval.requested | approval.resolved
  usage.recorded
  checkpoint.captured | checkpoint.restored | checkpoint.compared
  workspace.diff.updated
  projection.published
  ```

  Provider-native notification names are **never** encoded as canonical types.
- **Exactly-once command effect:** the local `command_receipts` table stores completed receipts keyed by `commandId`. Redelivered commands return the original receipt result without re-running the decider or reactors.

## Rejected Alternatives

- **Keep ad-hoc Convex mutations with no event model.** Rejected: does not address the ordering, idempotency, replay, or provider-swap problems.
- **Use a provider's native event format as canonical.** Rejected: couples the core to one provider and prevents multi-provider support. Normalization at the adapter seam is the correct separation.
- **Use a full CQRS/event-sourcing framework.** Rejected: too much weight. The pattern (commands → events → projections) is adopted; the framework is not.

## Migration Compatibility

- The legacy path continues to write v1 Convex documents directly with no event envelope. These documents are treated as opaque history during the shadow and cutover phases.
- During the **migrate** phase, existing thread/message/event/approval/checkpoint metadata is converted into initial projection snapshots with a `source: "v1-import"` provenance marker. Imported sequences are not conflated with kernel-native sequences.
- New kernel-mode runs produce canonical events only. The legacy and kernel paths **never execute the same user turn simultaneously.**

## Rollback

- Set `RELAY_RUNTIME_MODE=legacy`. Kernel events remain in the local store and Convex projection tables but are inert — legacy workers ignore them.
- Kernel projection tables can be truncated and re-backfilled from v1 source documents if needed. They are additive and carry no exclusive ownership of any legacy data.

## Consequences

- **Easier:** the reducer is pure and testable with exhaustive switch checks. New commands and transitions are safe to add.
- **Easier:** replay and crash recovery are deterministic — replay the stored event stream, apply the same reducer, get the same state.
- **Easier:** the browser (and any future client) resumes from a cursor by applying a snapshot then ordered events. No polling, no guesswork.
- **Harder:** every provider adapter must normalize its native events to canonical types. This is table-driven, bounded work — each new provider adds normalization rules, not core changes.
- **Harder:** the reducer must handle every command-state combination exhaustively. Adding a new state or command requires updating the reducer. TypeScript's exhaustiveness checking (`never` on the default case) makes this a compile-time guarantee.
- **Supersedes:** the v1 PRD's implicit event model (scattered Convex mutations). All new kernel work uses the canonical command/event model.
