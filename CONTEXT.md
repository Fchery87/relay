# Relay Domain Glossary

Terms used throughout the codebase. When naming a concept in an issue title, refactor proposal, hypothesis, or test name, use the term as defined here.

## Architecture

- **daemon** — the local Bun/TypeScript process that owns execution authority: provider sessions, process handles, local command scheduling, event ordering, retries.
- **Convex** — the cloud backend: handles auth, reactive subscriptions, and serves as the authenticated remote-command ingress and browser-facing projection plane.
- **harness kernel** — the durable, adapter-first replacement for the v1 raw agent loop. Built across `packages/` (contracts, harness-runtime, orchestration, local-store, workspace-runtime, client-runtime, provider-runtime, providers/codex-app-server).
- **legacy runtime** — the v1 raw agent loop (`apps/daemon/src/agent-loop.ts`) with per-work-type pollers. Retained behind `RELAY_RUNTIME_MODE=legacy` until cutover.

## Runtime modes

- **RELAY_RUNTIME_MODE** — environment variable: `legacy` (v1 raw loop, default), `shadow` (run kernel alongside legacy, compare projections), `kernel` (kernel is the execution authority).
- **cutover gate** — the set of conditions (release window, zero legacy, backup rehearsal, acceptance) that must all pass before `kernel` becomes the default.

## Core concepts

- **run** — a single agent session, created once, survives restarts. Owned by the daemon's local SQLite store.
- **turn** — a single user-to-assistant interaction within a run. Has at most one terminal event.
- **canonical event** — a typed, append-only event in the kernel's event store. Provider-native notifications are normalized to canonical events at the adapter seam; unknown notifications become bounded diagnostics.
- **command** — an intent to change run state. External commands originate from the browser (via Convex); internal commands originate from reactors (provider events, workspace results, checkpoint results, projection acknowledgements).
- **command receipt** — an immutable record keyed by `commandId`. Redelivered commands return the original receipt result without re-executing (exactly-once effect).
- **projection outbox** — local outbox of canonical events awaiting publication to Convex. Claimed with lease, published in bounded batches, acknowledged only after Convex confirms the durable contiguous sequence.
- **projection cursor** — the highest contiguous sequence published to Convex. The browser resumes from this cursor.
- **snapshot** — a point-in-time `RunSnapshot` (runId, status, sequence, streamVersion). Combined with ordered events after the snapshot's sequence, any client can reconstruct the full state.

## Store tables (local SQLite)

- `run_snapshots` — the authoritative run state (status, sequence, stream version).
- `run_events` — the canonical event log (unique event_id, unique (run_id, stream_version), indexed by (run_id, sequence)).
- `command_receipts` — immutable completed command records (unique command_id).
- `projection_outbox` — events pending publication to Convex (leased, acknowledged).
- `provider_sessions` — active provider sessions (provider_instance_id + run_id).
- `workspaces` — durable worktree records (run_id, repo_path, worktree_path, base_commit, permission_profile).
- `checkpoints` — per-turn checkpoints (checkpoint_id, run_id, turn_id, commit_sha, ref).
- `leases` — distributed lease registry.

## Store tables (Convex, widen-only)

- `commandInbox` — authenticated remote-command ingress (status: pending → claimed → completed/rejected).
- `projectionEvents` — canonical events published from the daemon (strict per-run sequence; next-or-duplicate).
- `projectionSnapshots` — run snapshots published from the daemon.
- `projectionCursors` — cursor state per machine (inbound/outbound direction).

## Provider model

- **ProviderDriver** — validates provider-instance configuration and creates scoped `ProviderSessionAdapter`s.
- **ProviderSessionAdapter** — maps Relay lifecycle calls (startSession, resume, send, steer, interrupt, resolveApproval, stop) to provider-native methods.
- **normalization** — the table-driven mapping from provider-native notifications to canonical events. Unknown notifications → bounded diagnostics, never crashes.
- **Codex app-server** — the first real provider adapter. Communicates over stable stdio JSON-RPC; Codex owns its native session and turn behavior.

## Sandbox

- **permission profile** — `read-only` | `workspace-write` (default, network denied) | `full-access`. Persisted per run.
- **sandbox executor** — the single interface all non-provider commands route through. Platform adapters: Linux (bubblewrap), macOS (Seatbelt), Windows (fail-closed).
- **escape suite** — the canonical set of tests proving that out-of-worktree writes, `.env` reads, `/proc/*/environ` reads, symlink escapes, and network access are technically blocked.

## History and context

- **canonical history** — a deterministic history snapshot rebuilt from ordered events. Same events → same snapshot. Resumable from stored snapshot + new events.
- **context policy** — compaction at 80% budget → ~40% target, with pinned invariants (system prompt, active plan, unresolved review comments, last N turns).
- **compaction artifact** — a summary of compacted history items, stored with provenance for recovery/exports.

## Governance

- **chokepoint** — the before-tool gate: capability × risk tier × policy rules → allow/deny/ask.
- **approval card** — rendered in the browser when a tool call is classified as "ask". Resolved from any signed-in browser or device.
- **audit log** — every governance decision (allow/deny/ask) is recorded with capability, risk, summary, and thread.

## Operations

- **kill-point recovery** — deterministic crash testing at every lifecycle phase (after command receipt, before event append, after outbox claim, etc.). Proves the store converges.
- **widen-migrate-narrow** — the Convex schema discipline: additive changes first (widen), dual-write/backfill second (migrate), verified removal third (narrow). Narrow is irreversible.
- **shadow mode** — `RELAY_RUNTIME_MODE=shadow` runs the kernel alongside legacy and compares decisions/projections without dual-executing side effects.

## Naming conventions

- Identifiers are branded strings (`RunId`, `TurnId`, `CommandId`, `EventId`, etc.) — phantom brands prevent accidental interchange.
- Events use dot-separated namespacing: `run.created`, `provider.session.started`, `turn.started`, `assistant.delta`, `activity.completed`, `approval.requested`, `usage.recorded`, `checkpoint.captured`, `projection.published`.
- Commands use dot-separated namespacing: `run.create`, `run.resume`, `run.stop`, `turn.send`, `turn.steer`, `turn.interrupt`, `approval.resolve`, `checkpoint.restore`.
