# Relay Harness Kernel & Production Readiness

Status: ready-for-agent

> Binding self-hosted recovery and cutover detail lives in the active implementation plan at
> `docs/plans/2026-07-22-self-hosted-convex-recovery-implementation-plan.md`.
> This spec is the problem/solution framing and the contract a ready-for-agent works against.

## Problem Statement

Relay v1 works, but it is built on a brittle foundation. The daemon owns a **raw, one-shot agent loop** that it polls into existence: a flock of per-work-type workers each re-scan a Convex table on a ~200 ms timer to claim the next message, approval, command, or checkpoint. Because no local component owns run state durably, the system strands work whenever it is interrupted. A provider call that throws after a message is claimed leaves the thread **permanently stuck "running"**; a daemon restart has no ordered replay, so in-flight turns, projected activity, and checkpoints can diverge or vanish; duplicate or reordered Convex delivery is not provably idempotent. The only provider seam is a thin `ModelProvider` wrapper tied to Relay's hand-rolled loop, so adopting a deep provider like the Codex app-server — which owns its own session, approval, and streaming semantics — means either forking the loop or fighting it.

The user-visible consequences: turns that never recover from a crash, activity that appears out of order or is silently lost after a reconnect, an inability to swap or harden providers behind a contract, and a cloud transport that mixes "what the operator must trust" with "what the daemon must keep private." None of this is acceptable for a tool developers run against their own machines, code, and credentials.

## Solution

Replace the polling-driven raw loop with a **durable, adapter-first harness kernel**, then harden the complete browser → Convex → daemon workflow for production operation.

- **The local daemon stays the execution authority.** A WAL-backed local SQLite store owns run, turn, provider-session, workspace, command-receipt, event, and outbox state. **One serialized orchestration module** is the sole owner of run-state transitions; it validates each command against current state, appends canonical events, updates projections, and dispatches side-effect reactors — all in one local transaction.
- **A deep `HarnessRuntime` interface hides orchestration and provider detail.** It exposes a run's whole lifecycle (create / resume / send / steer / interrupt / resolve-approval / stop) plus snapshot and ordered-event observation. The same contract suite passes against a deterministic fake, the local durable implementation with a fake provider, and the real Codex app-server adapter — making providers swappable and provably conformant.
- **Codex app-server becomes the first real adapter** over stable stdio JSON-RPC, owning its native session and turn behavior; Relay owns orchestration, remote supervision, governance, workspaces, checkpoints, subagents, MCP coordination, synchronization, and product state. A deterministic fake is the second adapter; the legacy raw-provider path is retained only behind a migration flag.
- **Convex becomes the authenticated remote-command ingress and browser-facing projection plane** — it carries user/device intents in and curated, resumable, redacted projections out. It never owns provider process state.
- **At-least-once transport, exactly-once effect.** Unique command IDs and durable receipts make redelivery harmless; an append-only event log with strictly increasing per-run sequence lets any client resume from a cursor without gaps or duplicates.
- **No big-bang rewrite.** A `RELAY_RUNTIME_MODE=legacy|shadow|kernel` flag gates the old path behind the new one until the production acceptance gates pass; schema changes follow a widen → migrate → narrow discipline so main stays green and releasable at every phase.

## User Stories

1. As a developer, I want a running turn to **recover after the daemon crashes and restarts**, so that a killed process never strands my work as "running" forever.
2. As a developer, I want the same turn to **resume cleanly from a durable checkpoint** after a provider process is lost, so that provider crashes are a retry, not data loss.
3. As a developer, I want **reconnecting to a run to replay from the exact last sequence** I saw, so that I never miss or re-see activity after a network blip or refresh.
4. As a developer, I want **duplicate delivery of a command to produce exactly one effect**, so that retries by the cloud transport can't double-execute, double-charge, or double-edit.
5. As a developer, I want **two parallel runs on the same repo to stay isolated**, so that concurrent threads never corrupt each other's state or worktree.
6. As a developer, I want each run to **process one state transition at a time** while several runs proceed concurrently, so that ordering within a run is predictable without serializing my whole machine.
7. As a developer, I want the agent loop to **no longer depend on constant polling timers**, so that activity begins promptly and idles cheaply instead of hammering the cloud every 200 ms.
8. As a developer, I want a **Codex turn to start, stream, request approval, be steered, be interrupted, resume after restart, checkpoint, and complete**, all through one interface, so that a first-class provider works end to end.
9. As a developer, I want to **steer an in-flight turn** and have it land at the right boundary, and an **explicit Stop to abort the turn safely**, with approvals never auto-resolving from queued input.
10. As a developer, I want **approval requests to round-trip correctly between the browser and the daemon** using the right credentials, so that an approval card I resolve actually reaches the waiting turn.
11. As a developer, I want risky actions to **pause into an approval card** and denies to **actually block execution**, so that governance is a real gate, not a suggestion.
12. As a developer, I want every governance decision **written to an audit log**, so I can reconstruct exactly what was allowed, denied, and why.
13. As a security-conscious developer, I want **subagent capabilities to only ever narrow from the parent's ceiling** at every hop, so delegation can never escalate privilege.
14. As a security-conscious developer, I want command execution **technically confined to the worktree and a per-run temp dir**, so that a sandbox escape is blocked by the OS, not merely by policy.
15. As a security-conscious developer, I want attempts to read daemon credentials, `.env`, `/proc/*/environ`, follow symlinks out of the worktree, or reach private/loopback networks to **fail technically**, so the sandbox can't be talked out of.
16. As a developer, I want a **read-only / workspace-write / full-access permission profile** persisted per run, with workspace-write (network denied) as the safe default, so the blast radius of any turn is bounded and known.
17. As a developer on Windows, I want sandbox behavior to be **explicit and fail-closed** where enforcement is unavailable, with the limitation surfaced in the UI and run record, rather than a silent weaker default.
18. As a developer, I want my **worktree, provider instance, effective permission profile, and checkpoint baseline to be durable before a run's first turn starts**, so a run is never half-initialized.
19. As a developer, I want **per-turn checkpoints captured before and after a turn**, idempotent and crash-safe, so that reverting a bad turn is a one-click restore, not archaeology.
20. As a developer, I want **missing or moved worktrees detected and reconciled** on startup, so the daemon self-heals instead of silently writing to the wrong place.
21. As a developer, I want **canonical history** (input, assistant text, activity summaries, approvals, subagent results, checkpoints) that I can read, export, and recover from — independent of any provider's private context.
22. As a developer, I want context management to **compact toward a budget with pinned invariants** and **spill oversized tool output to local artifacts**, so long threads stay affordable without losing what matters.
23. As a developer, I want commands and messages arriving through the cloud backbone **parsed as untrusted input at the daemon ingress**, so a compromised account can't trivially own my machine.
24. As a security-conscious developer, I want **secrets and raw prompts excluded from cloud projections and default logs**, with only redacted summaries and bounded deltas leaving my machine.
25. As a developer, I want a run to be **observable as an ordered event stream**, so that browser, recovery logic, and exports all agree on what happened.
26. As a developer, I want **browser mutations to flow through an authenticated command inbox** and be delivered to the daemon at-least-once, so my intent reaches execution reliably.
27. As a developer, I want **projections published to Convex in strict per-run sequence**, accepted only as the next sequence or an exact duplicate, so the browser never sees gaps or reorderings.
28. As a developer, I want the **outbox cursor to advance only after the cloud confirms the durable contiguous sequence**, so a lost response after a successful write can't lose or duplicate visible activity.
29. As a developer, I want **existing threads to migrate to the new projections without downtime** and without breaking the legacy display, so an upgrade never interrupts active work.
30. As a developer, I want **growing reads paginated and bounded**, so long-running accounts don't slow the browser or the daemon.
31. As a developer, I want my **machines, projects, and threads scoped to my owner identity**, so one user can never read or act on another user's runs, roles, or approvals.
32. As a developer, I want a **shadow mode** that runs the new kernel alongside the legacy path and proves projection parity, so the cutover is backed by evidence, not hope.
33. As a developer, I want the **runtime to cut over per machine** (developer machines → opt-in canary → default kernel) with an emergency legacy path retained for one release window, so I can roll back if needed.
34. As a developer, I want rollout to **stop automatically on invariant violations** — sequence gaps, duplicate side effects, cross-owner access, sandbox escape, unrecoverable active runs, or projection divergence — so a bad release can't quietly corrupt my state.
35. As an operator, I want **structured traces that join** browser command → Convex ingress → local command → provider turn → tool activity → checkpoint, so I can diagnose any failure end to end.
36. As an operator, I want **metrics, health, and a diagnostic export**, so I can tell whether the daemon is healthy and why it isn't.
37. As an operator, I want **retention, compaction, and storage-pressure policy** automated, so a long-lived daemon doesn't fill the disk or grow without bound.
38. As an operator, I want **deterministic kill-point recovery** validated at every lifecycle phase, so I have proof — not a belief — that crashes are recoverable.
39. As an operator, I want a **daemon process supervisor** that owns restart, graceful shutdown, and lease release, so the daemon is operable like a real service.
40. As an operator, I want **version compatibility checks and safe upgrades** that understand post-migration schema, so upgrading doesn't brick a machine or its data.
41. As an operator, I want **backup, restore, and corruption-recovery** procedures that are rehearsed, so a bad disk or migration is recoverable.
42. As an operator, I want **signed and versioned release artifacts** plus a one-command fresh install, upgrade, and uninstall across the OS matrix, so deployment is reproducible and safe.
43. As an operator, I want an **operator runbook** covering the production acceptance scenario, so shipping and recovery are documented, not tribal knowledge.
44. As a security reviewer, I want a **written, tested threat model** covering the browser/Convex/daemon trust boundaries, so the security posture is explicit and verified.
45. As a security reviewer, I want **secrets, credentials, and device identity hardened** (tokens never on argv, scoped identities), so the trust root is minimal and defensible.
46. As a security reviewer, I want an **adversarial validation gate** — authorization matrix, sandbox escape suite, secret scanning, hostile-input corpus — run before release, so the model is attacked, not just asserted.
47. As a developer, I want **service-level objectives and load profiles** defined and measured, so performance regressions are caught by data, not feel.
48. As a developer, I want the system **optimized from measured signals** (no hot pollers, bounded batch sizes, lean projections), so it stays lightweight, fast, and powerful.
49. As a developer, I want the whole production path to **pass a defined acceptance scenario on the supported OS matrix** before the legacy path is removed, so "production ready" means a green gate, not a checklist.
50. As a developer, I want the **legacy runtime narrowed away and removed** only after at least one release window on kernel-default with zero legacy activations and a verified backup/rollback rehearsal, so cleanup never outruns safety.
51. As a developer, I want **provider-specific data kept out of canonical contracts**, so adding or swapping a provider never leaks one provider's shapes into the core.
52. As a developer, I want a **second provider to be blocked until the provider seam passes its conformance suite**, so the contract, not hope, governs what "supported" means.

## Implementation Decisions

All architecture decisions below are locked; the task-level plan is the binding detail.

1. **Adapter-first harness (reverses the v1 "own raw loop" decision).** Codex app-server owns Codex-native session and turn behavior. Relay owns orchestration, remote supervision, governance policy, workspaces, checkpoints, subagents, MCP coordination, synchronization, and product state. `raw-llm` survives only as a temporary migration adapter and optional text-generation module.
2. **Local execution authority.** Provider sessions, process handles, local command scheduling, event ordering, and retry ownership all live in the daemon.
3. **Convex projection plane.** Convex carries authenticated remote intents in and curated, resumable browser projections out. It does **not** own provider process state.
4. **One transition owner.** Only the orchestration module changes run state. React, the Convex gateway adapter, provider adapters, and workspace adapters emit commands/events; none patch run status independently.
5. **Append-only canonical events.** Every accepted command produces zero or more ordered events in the **same local transaction** as its receipt and projection updates.
6. **At-least-once transport, exactly-once command effect.** Convex and the local outbox may redeliver; unique command IDs and immutable completed receipts make redelivery harmless.
7. **Per-run serialization.** One run processes one state transition at a time. Independent runs may execute concurrently under a configurable global limit.
8. **Sandbox plus approval (not either/or).** The sandbox technically limits execution; approval policy decides whether Relay may widen those limits. Neither substitutes for the other.
9. **Widen-migrate-narrow.** All live Convex and local schema changes are additive first, then dual-read/dual-write compatible, then batched-migrated, then verified, then narrowed.
10. **No big-bang rewrite.** The existing path stays behind `RELAY_RUNTIME_MODE = legacy | shadow | kernel` (default `legacy` until cutover) until the production acceptance gates pass.

**Primary contract — the `HarnessRuntime` interface (the single testing seam).** Workspace, provider, store, and Convex adapters are deliberately kept out of this external interface:

```ts
export interface HarnessRuntime {
  createRun(input: CreateRunInput): Promise<RunSnapshot>;
  resumeRun(input: ResumeRunInput): Promise<RunSnapshot>;
  sendTurn(input: SendTurnInput): Promise<TurnReceipt>;
  steerTurn(input: SteerTurnInput): Promise<void>;
  interruptTurn(input: InterruptTurnInput): Promise<void>;
  resolveApproval(input: ResolveApprovalInput): Promise<void>;
  stopRun(input: StopRunInput): Promise<void>;
  snapshot(input: SnapshotInput): Promise<RunSnapshot>;
  observe(input: ObserveInput): AsyncIterable<EventEnvelope<CanonicalEventType, unknown>>;
}
```

*(Originates from the locked contracts in the implementation plan; the same suite runs against the fake, the local implementation, and the Codex adapter.)*

**Canonical event envelope** (`sequence` assigned by storage; `streamVersion` is the optimistic version within one run stream):

```ts
type EventEnvelope<TType extends string, TPayload> = {
  eventId: EventId; sequence: number; streamVersion: number; type: TType;
  runId: RunId; turnId?: TurnId; providerInstanceId?: ProviderInstanceId;
  correlationId: CorrelationId; causationId?: CausationId;
  occurredAt: number; payload: TPayload;
};
```

**Canonical command envelope** (external commands for create/resume/send/steer/interrupt/approval/stop/restore; internal commands for provider events, workspace results, checkpoint results, and projection acknowledgements):

```ts
type CommandEnvelope<TType extends string, TPayload> = {
  commandId: CommandId; type: TType; runId: RunId;
  expectedStreamVersion?: number; correlationId: CorrelationId; causationId?: CausationId;
  actor: { kind: "user" | "device" | "provider" | "system"; id: string };
  issuedAt: number; payload: TPayload;
};
```

**Canonical event union** (provider-native notification names are never encoded as canonical types): `run.created | run.started | run.stopping | run.stopped | run.failed`, `provider.session.started | resumed | stopped`, `turn.started | steered | completed | failed | interrupted`, `assistant.delta | completed`, `activity.started | delta | completed | failed`, `approval.requested | resolved`, `usage.recorded`, `checkpoint.captured | restored`, `projection.published`.

**Run state machine** (owned by one pure `reduceRun(state, event)` reducer — the only function that defines run-status semantics; exhaustive switch checks): `created → ready → running → awaiting_approval → stopping → stopped / completed / failed`.

**Permission profiles** (canonical, persisted per run): `read-only`, `workspace-write` (default; network denied; on-request approval to widen), `full-access`. All non-provider commands route through one `SandboxExecutor`; provider turns use the provider's own configured sandbox and report the effective profile canonically.

**Kernel local store (WAL SQLite)** owns, in one transaction: `run_events`, `run_snapshots`, `command_receipts`, `projection_outbox`, `provider_sessions`, `workspaces`, `leases` — with unique `event_id`, unique `command_id`, unique `(run_id, stream_version)`, indexed `(run_id, sequence)`, indexed unpublished outbox, and foreign-key checks on.

**Convex additive tables** (widen-only): `commandInbox`, `projectionEvents`, `projectionSnapshots`, `projectionCursors` — uniqueness enforced transactionally via `.unique()` lookups since Convex has no unique indexes.

**Required invariants:** strictly increasing, never-reused event sequence per run; globally unique, immutable-completed `commandId`; at most one terminal turn event; one provider-native event maps to at most one canonical event identity; a projection cursor advances only after the corresponding cloud write succeeds; a daemon crash cannot leave a command permanently owned without an expired lease or recoverable receipt; a run's worktree/provider/permission/checkpoint baseline is durable before its first turn; browser and Convex input is untrusted at ingress; secrets and raw prompts are excluded from cloud projections and default logs; legacy and kernel paths never execute the same user turn simultaneously.

**Adapters & seams:** `ProviderDriver` validates instance config and creates scoped `ProviderSessionAdapter`s; `ProviderInstanceRegistry` owns configured instances and never reads environment variables from call sites. Codex maps `startSession→thread/start`, `resume→thread/resume`, `send→turn/start`, `steer→turn/steer`, `interrupt→turn/interrupt`; the Codex thread ID is persisted before session start is acknowledged. Relay-owned tools and MCP servers are bridged through a provider-supported dynamic-tool / daemon-local stdio MCP adapter, enforced against the persisted capability ceiling, waiting on a durable receipt. A `RelayToolBridge` submits an internal orchestration command with run/turn/correlation identity and returns the typed subagent result.

**Release gates (each phase is releasable):** *Kernel complete* (a real Codex turn lives the full lifecycle through `HarnessRuntime`; duplicate delivery → one effect; projection loss/reconnect resumes without gaps or dupes; no 200 ms claim pollers on the kernel path). *Operationally reliable* (kill tests at every phase; automated migration/outbox replay/provider restart/worktree reconciliation; sandbox enforced on Linux+macOS, explicit fail-closed on Windows; joined structured traces). *Production complete* (signed/versioned artifacts; controlled upgrades + compatibility checks; migration rollback + backup/recovery; security review; load tests; operator runbook; the full acceptance scenario passes on the OS matrix).

## Testing Decisions

- **A good test exercises external behavior at the highest seam and never asserts implementation details.** It treats the system as a black box and asserts on observable outcomes — snapshots, ordered event streams, projected documents, and filesystem/git effects — not on how they were produced.
- **Primary seam — the `HarnessRuntime` interface (confirmed).** One contract suite drives a run's whole lifecycle (create / resume / send / steer / interrupt / resolve-approval / stop), asserts on `RunSnapshot`s and the ordered canonical event stream, and proves crash/restart recovery — all without touching SQLite, provider processes, or Convex. The **identical** suite runs against (a) the deterministic fake runtime, (b) the local durable implementation with the fake provider, and (c) the real Codex app-server adapter. This is the conformance gate that makes providers swappable and is the single primary seam.
- **Retained seam — the Convex document boundary (the existing v1 E2E seam), framed as the same logical seam viewed across transport.** Browser/Convex/daemon/fake-provider end-to-end continues on every PR; the browser and the test driver are interchangeable clients asserting on projected documents **and** filesystem/git effects in the worktree. The only supporting fake is the deterministic provider (native-event in → canonical-event out).
- **Below the seam (not new seams):** pure unit tests for the run-state `reduceRun` reducer, the pure decider (`{ events, effects }` per command/state, no I/O), event normalization (table-driven provider-native → canonical mapping; unknown notifications become bounded diagnostics, never crashes), permission-policy evaluation, capability-narrowing, and context compaction.
- **Reliability tests** drive a crash/network/disk/duplicate/reorder matrix and assert convergence without sleeps — tests synchronize through durable receipts and `drain()`, not timers.
- **Security tests** run an authorization matrix, a sandbox-escape suite, secret scanning, and a hostile-input corpus.
- **Release tests** cover the compiled binary, fresh install, upgrade, backup/restore, supervisor, uninstall, and the OS matrix; a protected, opt-in real-Codex smoke runs nightly/release (`RELAY_E2E_CODEX=1`), skipped in ordinary CI.
- **Modules exercised:** the kernel packages for contracts, harness-runtime, orchestration, local-store, provider-runtime, providers/codex-app-server, workspace-runtime, and client-runtime; the daemon sync adapters and composition root; and the Convex command/projection/migration surface.
- **Prior art:** the relay-v1 PRD testing decisions (Convex document boundary as primary seam; scripted provider as the only fake; latency budgets against the batch-flush ceiling); the existing daemon `*.e2e.test.ts` and `*.convex.test.ts` suites; and the Thanos vitest mirror as the stylistic reference for unit tests.

## Out of Scope

- **Reimplementing Effect or T3 Code's full event-sourcing framework** — we borrow patterns, not a framework.
- **Electron, live preview (permanently excluded by founder decision), SSH, Tailscale, WSL backend pools, or native mobile clients.**
- **Interactive PTY support during the kernel migration.**
- **Provider-specific UI data leaking into canonical contracts.**
- **Supporting more than Codex plus the deterministic fake before the provider seam passes its conformance suite.**
- **Cloud sandbox / zero-install execution and scheduled automations** — deferred to v2.
- **Productization: pricing, billing, and multi-tenant hardening beyond the existing multi-user auth.**

## Further Notes

- The **self-hosted recovery implementation plan** (`docs/plans/2026-07-22-self-hosted-convex-recovery-implementation-plan.md`) is the active binding detail for reliability, migration, security, live-backend acceptance, and kernel cutover gates. The earlier harness-kernel plan remains historical implementation context.
- **Three ADRs are part of this effort** and supersede the old own-loop decision while preserving `raw-llm` as a temporary adapter: adapter-first local harness; local authority + Convex projections; canonical command/event model. Each records context, decision, rejected alternatives, migration compatibility, rollback, and consequences.
- **Canonical lifecycle:** browser mutation → `commandInbox` → daemon sync receives/retries → local receipts reject duplicates → decider validates against run state → one transaction appends events + updates projections + receipt + outbox → reactors perform provider/workspace/checkpoint side effects → results return as internal commands → outbox publishes ordered events/snapshots to Convex → client-runtime applies snapshot then events in sequence → React renders.
- **Execution dependency:** tasks 1–3 (decisions + safety rails) → 4–8 (contracts + deep interfaces) → 9–13 (local durability + orchestration) → parallel 14–17 (Codex adapter) and 18–21 (workspace/security/history) → 22–27 (Convex widen/sync/migrate) → 28–34 (client migration + kernel cutover) → 35–45 (reliability, security, operations) → 46–50 (performance, conformance, acceptance, narrowing). Task 25 is a multi-deploy production operation, not just a code merge; Task 50 is irreversible cleanup gated on a verified backup/rollback rehearsal.
- **Reference material:** the Codex app-server manual (stable stdio transport; do not build on the experimental WebSocket transport); the T3 Code reference commit; the user's Thanos setup (`~/.pi`) for governance, subagent roster, and `models.json`.
- **Standing quality bar:** extremely lightweight, fast, powerful. When a decision trades power against weight, surface the trade explicitly. Removing hot pollers, bounding batches, and keeping projections lean are first-class acceptance criteria, not afterthoughts.
