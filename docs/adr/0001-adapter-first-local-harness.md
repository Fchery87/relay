# ADR 0001: Adapter-First Local Harness

**Status:** Accepted  
**Date:** 2026-07-15  

## Context

Relay v1 implements a raw, daemon-owned agent loop (`agent-loop.ts`) that directly calls LLM providers through a thin `ModelProvider` interface, manages its own tool execution and context, and claims work by polling Convex rows on a ~200 ms timer. This architecture was chosen because it was the fastest path to a working v1 — a single daemon binary that owns everything.

The limitations became clear as Relay matured:
- The loop is single-purpose: every provider's session, streaming, approval, and steering semantics must be shoehorned into Relay's hand-rolled model.
- The daemon has no durable local authority — in-flight progress, event ordering, and work ownership are lost on restart, stranding turns permanently.
- Adopting a deep provider like the Codex app-server (which owns its own thread, turn, item, and approval semantics) requires fighting rather than composing with the loop.
- Every work-type worker independently polls Convex, creating a web of hot pollers that is fragile and wasteful.

A decision is needed on the permanent execution architecture for Relay's agent core.

## Decision

**Reverse the v1 "own raw agent loop" decision. Adopt an adapter-first harness architecture.**

- A **deep `HarnessRuntime` interface** defines the full run lifecycle (create / resume / send / steer / interrupt / resolve-approval / stop / observe-events) without exposing provider, store, workspace, or Convex internals. This is the single seam behind which every provider is interchangeable.
- Providers implement a `ProviderDriver` + `ProviderSessionAdapter` contract. Codex app-server is the first real adapter; a deterministic fake is the second adapter and the conformance gate.
- The daemon remains the **local execution authority** with a WAL-backed SQLite store that owns run, turn, provider-session, workspace, command-receipt, event, and outbox state. One serialized orchestration module is the sole owner of run-state transitions.
- Convex is demoted to an **authenticated remote-command ingress and browser-facing projection plane** — it carries intents in and curated, redacted projections out, but never owns provider process state.
- The legacy path is retained behind `RELAY_RUNTIME_MODE=legacy|shadow|kernel` until production acceptance gates pass. **No big-bang rewrite.**

## Rejected Alternatives

- **Keep the raw loop and wrap providers around it.** Rejected: every deep provider (Codex, future ones) would require forking the loop or maintaining a parallel one, defeating the purpose of a single daemon.
- **Adopt Effect or T3 Code's full event-sourcing framework.** Rejected: too much weight and learning curve for what Relay needs. We borrow the patterns (append-only events, pure decider, serialized orchestration) without adopting the framework.
- **Move execution into Convex actions (cloud sandbox).** Rejected: the daemon must own the local filesystem, shell, git, and API keys. Convex cannot execute local tools.

## Migration Compatibility

- `raw-llm` is preserved as a temporary migration adapter and optional text-generation module. It does not implement the full `HarnessRuntime` seam but serves as a bridge during the `legacy`→`shadow`→`kernel` cutover.
- All existing v1 workflows (turn, subagent, command, git, checkpoint, MCP) remain operational on the legacy path until each is routed through the orchestration engine in kernel mode.
- The Convex schema is never dropped or narrowed until the final contraction step (after the acceptance gates pass).

## Rollback

- Per-machine rollback: set `RELAY_RUNTIME_MODE=legacy` and restart the daemon. The legacy path is untouched throughout the migration.
- Binary rollback: restore the pre-upgrade backup and restart. Local SQLite schema migrations are forward-only during normal startup; binary rollback must understand the post-migration schema or restore the verified pre-upgrade backup.
- Any invariant violation (sequence gap, duplicate side effect, cross-owner access, sandbox escape, unrecoverable active run, projection divergence) is an automatic rollback condition.

## Consequences

- **Easier:** swapping providers becomes a matter of implementing one contract and passing the conformance suite. Adding a second provider after Codex is straightforward.
- **Easier:** daemon crashes are recoverable by construction — the WAL store is the system of record.
- **Easier:** event ordering, exactly-once command effects, and audit are provable locally rather than distributed across cloud gateways.
- **Harder:** the system is now a distributed state machine with at-least-once transport. Projection synchronization, clock skew, and redelivery must be handled explicitly.
- **Harder:** migration requires careful widen-migrate-narrow discipline on both Convex and the local store, and the `shadow`→`kernel` cutover must be proven with parity evidence before flipping the default.
- **Supersedes:** the v1 PRD's "Own agent loop" decision. The `ModelProvider` interface remains for the raw-llm adapter only.
