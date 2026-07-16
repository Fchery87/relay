# ADR 0002: Local Execution Authority with Convex Projections

**Status:** Accepted  
**Date:** 2026-07-15  

## Context

Relay v1 treats Convex as the single source of truth for nearly all mutable state: threads, messages, events, approvals, diffs, comments, checkpoints, commands, and the audit log. The daemon is a stateless worker in front of cloud documents — it claims work by polling, mutates documents as it progresses, and has no durable local authority. When the daemon restarts, all in-flight work ownership, partial progress, and event ordering are lost; only Convex documents survive.

This design carries two fundamental problems:

1. **Convex is not a process manager.** It cannot own provider sessions, stdin/stdout pipes, process handles, local command scheduling, or subagent lifecycles. The daemon must own these, yet the current architecture has no local store to anchor them.
2. **Cloud projections are the system of record for local execution.** Every event must round-trip through Convex before the daemon can observe it, creating the hot-poll pattern and coupling the daemon's internal consistency to cloud latency and availability.

A decision is needed on where execution authority lives and what role Convex plays.

## Decision

**Local execution authority. Convex is the projection plane, not the execution store.**

- **The daemon is the sole execution authority.** A WAL-backed local SQLite store is the system of record for run state, turn state, provider session identity, worktree identity, command receipts, canonical events, and the projection outbox. The daemon owns process handles, local scheduling, event ordering, retry policy, and lease management.
- **Convex carries authenticated remote-command ingress and curated, resumable browser projections.** Commands (create run, send message, steer, approve, stop) enter through an authenticated `commandInbox` table. Projected canonical events, snapshots, and cursor state are published from the local outbox in strict per-run sequence. Convex never owns provider process state.
- **At-least-once transport, exactly-once command effect.** Convex and the local outbox may redeliver. Unique command IDs and immutable completed receipts in the local store make redelivery harmless.
- **The browser resumes from a cursor:** client-runtime applies a snapshot then ordered events after their sequence, so reconnecting never misses or duplicates visible activity.

## Rejected Alternatives

- **Keep Convex as the primary store with a local cache.** Rejected: this preserves the dual-write problem and the hot-poll anti-pattern. A cache cannot own authoritative event ordering; only the execution authority can.
- **Drop Convex entirely and use a peer-to-peer transport.** Rejected: Convex provides zero-config reactive subscriptions, auth, and a hosted projection surface that lets any browser anywhere connect without opening ports. The developer experience of an SPA + no firewall config is non-negotiable.
- **Use Convex durable execution (Workflow/Workpool) for agent coordination.** Rejected: Convex workflows run inside Convex actions with no access to the local filesystem, shell, or git. They cannot own the agent loop. Workpool is earmarked for v2 scheduled automations where its dispatch semantics shine.

## Migration Compatibility

- All existing v1 Convex tables (threads, messages, events, approvals, diffs, checkpoints, etc.) remain untouched during the **widen** phase. New kernel tables (`commandInbox`, `projectionEvents`, `projectionSnapshots`, `projectionCursors`) are added additively.
- The legacy path continues to write v1 documents directly. Dual-write (legacy + kernel inbox) is introduced during the **migrate** phase.
- Existing threads are backfilled to kernel projections via a bounded, cursor-driven migration. Legacy display queries stay authoritative until the read-cutover.
- The v1 tables are **narrowed** (dropped or simplified) only after the full production acceptance gates pass — the final, irreversible step.

## Rollback

- Before the read-cutover: stop the backfill migration, revert Convex deployments to the widen-only state, and `RELAY_RUNTIME_MODE=legacy`.
- After the read-cutover but before narrowing: the legacy tables still exist and can be re-activated as the display source.
- After narrowing: rollback requires restoring the pre-narrow backup. This is why narrowing is the last, gated step.

## Consequences

- **Easier:** the daemon can process commands and events locally, with bounded cloud interaction only for intent ingress and projection egress. Polling is replaced by a reactive sync loop.
- **Easier:** event ordering, idempotency, and crash recovery are provable in one place (the local store transaction).
- **Easier:** secrets, raw prompts, and oversized output never leave the machine — only redacted summaries and bounded deltas are projected.
- **Harder:** two stores must stay in sync (local SQLite → Convex projections). The outbox cursor advances only after Convex confirms the durable contiguous sequence. Lost responses, partial batches, and reordered delivery must all converge.
- **Harder:** the daemon is no longer stateless — it must manage local migrations, backup, restore, and corruption recovery as part of its operational surface.
- **Supersedes:** the v1 PRD's "Convex is the sole backbone and transport" decision for the execution path. Convex remains the backbone for auth/subscriptions; it is no longer the store for execution progress.
