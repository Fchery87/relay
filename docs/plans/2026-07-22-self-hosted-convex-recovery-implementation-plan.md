# Self-Hosted Convex Recovery and Kernel Cutover Implementation Plan

**Status:** Proposed  
**Created:** 2026-07-22  
**Scope:** Self-hosted Convex reliability, daemon correctness, kernel architecture, security, migration, browser cutover, and production operations  
**Current release verdict:** **NO-GO for kernel cutover, schema narrowing, or production self-hosted claims**

## 1. Objective

Make Relay's self-hosted Convex deployment and daemon reliable before completing the kernel migration. The implementation must:

1. Stabilize the current legacy runtime on a real self-hosted Convex backend.
2. Make the local SQLite/WAL orchestration engine the only kernel execution authority.
3. Make Convex a bounded, authenticated command-ingress and projection plane.
4. Guarantee replay-safe command, provider-effect, and projection behavior across timeouts and restarts.
5. Close the shell, filesystem, pairing, role, and narrowing security boundaries.
6. Provide a complete and reversible hosted-history decision and migration path.
7. Cut the browser over only after live end-to-end parity is proven.
8. Keep `RELAY_RUNTIME_MODE=legacy` as the default and emergency rollback until all gates pass.

## 2. Non-goals

This plan does not:

- enable kernel mode before the acceptance gates pass;
- narrow or delete legacy Convex tables during the additive migration phases;
- treat `convex-test` as proof that a real self-hosted backend works;
- preserve the current `KernelDaemon` direct-provider loop;
- claim historical continuity unless hosted data is explicitly exported, imported, and verified;
- combine schema widening, data migration, read cutover, and schema narrowing in one deployment.

## 3. Blocking decisions

These decisions must be recorded before production deployment work begins. Earlier local correctness work may proceed while they are pending.

### Decision D1 — Production topology

Choose exactly one supported production topology:

- **D1-A: Hosted production, self-hosted local development.** Scope self-hosting claims to local development and keep hosted deployment automation explicit.
- **D1-B: Self-hosted production.** Define public/private ingress, TLS, Convex API/site URLs, operator ownership, process supervision, storage, backups, upgrades, and incident response.
- **D1-C: Per-customer/self-managed deployment.** Define the support matrix and division of operator responsibility.

**Required artifact:** `docs/adr/0004-convex-production-topology.md`

### Decision D2 — Hosted historical data

Choose exactly one outcome:

- **D2-A: Migrate hosted history.** Build and rehearse an export/import path with ID and owner remapping.
- **D2-B: Archive hosted history read-only.** Preserve access separately and start self-hosted state cleanly.
- **D2-C: Fresh start.** Explicitly communicate that accounts, pairings, and history do not carry over.

**Required artifact:** `docs/operations/convex-history-migration-decision.md`

### Decision D3 — Supported operating systems

Define which platforms must provide enforced sandboxing and live daemon acceptance:

- Linux
- macOS
- Windows

Unsupported enforcement combinations must fail closed rather than silently falling back to unrestricted execution.

**Required artifact:** `docs/operations/support-matrix.md`

## 4. Global invariants

All implementation phases must preserve these invariants:

1. Legacy remains the only production effect owner until kernel cutover.
2. A command ID identifies one immutable command envelope.
3. One canonical run ID is used across browser, Convex, daemon, SQLite, and projections.
4. A duplicate command cannot start a second provider or filesystem effect.
5. A snapshot never advances beyond the contiguous remote event prefix.
6. Local outbox rows are acknowledged only after durable Convex confirmation.
7. A failed or expired lease cannot allow an unfenced worker to commit a result.
8. Every user-, machine-, project-, thread-, and run-scoped operation enforces ownership at the boundary.
9. Provider-originated processes and filesystem operations use enforced sandbox/path boundaries.
10. No destructive migration runs without a verified backup and rehearsed restore.
11. No browser read cutover occurs before projection parity is proven.
12. No schema narrowing occurs in the same release as widening, migration, or read cutover.

## 5. Delivery strategy

Work is divided into ten milestones. Milestones 0–5 address immediate correctness and can proceed without a production-topology decision. Milestones 6–9 require the relevant decisions above.

---

# Milestone 0 — Freeze cutover and establish a trustworthy baseline

## Goal

Prevent further migration risk and make all existing failures reproducible.

## Changes

### Runtime safety

Modify:

- `apps/daemon/src/runtime-mode.ts`
- `apps/daemon/src/runtime-mode.test.ts`
- `apps/daemon/src/config.ts`
- `apps/daemon/src/index.ts`

Requirements:

- Keep the default runtime mode `legacy`.
- Add an explicit kernel kill switch, e.g. `RELAY_KERNEL_DISABLED=1`, that overrides accidental kernel configuration.
- Reject unknown/empty runtime modes.
- Log the effective mode, backend URL origin, daemon version, and kernel-disabled state without logging credentials.
- Emit an invariant warning if kernel or shadow mode is selected without required readiness evidence.

### Verification entrypoints

Modify:

- `package.json`
- `scripts/run-conformance-matrix.ts`
- `.github/workflows/ci.yml`

Requirements:

- Make the documented root test entrypoint invoke Convex tests through Vitest rather than allowing Bun to load `import.meta.glob` suites directly.
- Keep unit, Convex, build, bundle, security, and conformance commands independently runnable.
- Preserve failing evidence rather than hiding flaky/time-sensitive failures with retries.

### Immediate type failures

Fix:

- `packages/providers/codex-app-server/src/codex-session-adapter.integration.test.ts`
- related canonical event types only if the test exposes a real contract mismatch

Do not weaken event unions or cast through the failures.

## Tests

```bash
bun run typecheck
bun run test
bun run conformance:matrix
bun run build
bun run bundle:check
bun run security:gate
```

## Exit criteria

- All commands above pass from a clean checkout.
- The two full-suite-only daemon failures pass in at least 10 consecutive full runs or are deterministically reproduced and fixed.
- Direct root test execution no longer produces `import.meta.glob` errors.
- Legacy remains the default.

## Commit boundary

`chore(reliability): freeze kernel cutover and restore trustworthy verification`

---

# Milestone 1 — Stabilize legacy operation on self-hosted Convex

## Goal

Make the current user-facing runtime reliable before rewiring the kernel.

## 1.1 Separate heartbeat from project reconciliation

Modify:

- `apps/daemon/src/index.ts`
- `apps/daemon/src/relay-client.ts`
- `apps/daemon/src/relay-client.test.ts`
- add `apps/daemon/src/machine-heartbeat.ts`
- add `apps/daemon/src/machine-heartbeat.integration.test.ts`

Requirements:

- Run `heartbeatOnce()` on an independent 10-second loop.
- Project reconciliation must not be used as a liveness signal.
- Prevent overlapping heartbeat calls.
- Apply bounded retry/backoff.
- Stop the daemon on confirmed token revocation.
- Ensure shutdown clears heartbeat and reconciliation timers.

Acceptance:

- With an unchanged project list, `lastHeartbeatAt` advances for at least 60 seconds.
- Machine presence remains online beyond the browser's 30-second threshold.
- A revoked device token stops further claims.

## 1.2 Replace expensive claim scans with indexed eligibility

Modify:

- `convex/schema.ts`
- `convex/conversations.ts`
- `convex/subagents.ts`
- relevant Convex tests
- `apps/daemon/src/pollers.ts`
- `apps/daemon/src/index.ts`

Requirements:

- Add compound indexes representing actual claim eligibility and machine ownership.
- Avoid loading thread, project, role, and review state for dozens of ineligible candidates.
- Keep claims bounded.
- Separate the atomic claim from expensive result enrichment where possible.
- Coordinate poller concurrency; staggering alone is not the final design.
- Instrument claim duration and outcome.

Live acceptance against a pinned self-hosted backend:

- p95 claim duration below 400 ms.
- p99 claim duration below 700 ms.
- no `UserTimeout` during a 15-minute idle/load scenario.
- no unexplained OCC failures.
- no duplicate claims.

## 1.3 Supervise daemon and backend processes

Add or modify:

- `docs/operations/process-supervision.md`
- `docs/operations/self-hosted-convex.md`
- supported service definitions under `packaging/` or `scripts/`
- daemon shutdown lifecycle in `apps/daemon/src/index.ts`

Requirements:

- Provide one supported dev watch/restart command.
- Provide supported production/user-service definitions for the selected platforms.
- Centralize shutdown of timers, pollers, MCP processes, provider processes, SQLite, and outstanding leases.

## Tests

- Time-controlled heartbeat composition test.
- Claim eligibility/ownership tests.
- Live 15-minute backend/daemon soak.
- SIGTERM and restart test.
- Backend restart with daemon reconnect.

## Commit boundaries

1. `fix(daemon): separate machine heartbeat from project reconciliation`
2. `perf(convex): index and bound legacy work claims`
3. `feat(ops): supervise self-hosted backend and daemon lifecycle`

---

# Milestone 2 — Close canonical command and identity contracts

## Goal

Define one executable protocol before changing execution ownership.

## Changes

Modify or add:

- `packages/contracts/src/ids.ts`
- `packages/contracts/src/commands.ts`
- `packages/contracts/src/runtime-schemas.ts`
- `packages/contracts/src/events.ts`
- `packages/contracts/src/index.ts`
- `convex/commands/inbox.ts`
- `apps/daemon/src/sync/convex-command-source.ts`
- `apps/daemon/src/kernel-daemon.ts` temporarily as a consumer only

Requirements:

- Define branded canonical `RunId`, `CommandId`, `EventId`, `TurnId`, `ProjectId`, and correlation IDs.
- Define one exhaustive command discriminator and payload schema.
- Validate the same contract at:
  - browser submission;
  - Convex ingress;
  - daemon deserialization;
  - local orchestration admission.
- Enforce payload byte limits and bounded strings/arrays.
- Reject unknown commands before persistence or execution.
- Allocate the canonical run ID before `run.create`; do not generate and discard a second local ID.
- On duplicate command ID, require every immutable envelope field to match. Reject conflicts.
- Make provider/native event identity deterministic from stable native identity and generation, not `Date.now()`/`Math.random()`.

## Command conformance table

Every accepted command must have an end-to-end implementation and test. At minimum:

- `run.create`
- `run.resume`
- `run.stop`
- `turn.send`
- `turn.steer`
- `turn.interrupt` or one consistently named stop command
- `approval.resolve`
- `checkpoint.restore`
- `checkpoint.compare`
- `subagent.run`
- supported Git commands, or explicit ingress rejection until implemented

## Tests

- Table-driven ingress/daemon command parity test.
- Create → send → steer → stop using one run ID.
- Conflicting duplicate command ID rejection.
- Oversized/malformed payload rejection.
- Cross-owner/machine/project/run rejection.
- Deterministic event identity under duplicate provider notification.

## Exit criteria

- Convex and daemon command vocabularies cannot drift without a failing test.
- No casts are required to turn legacy thread IDs into kernel run IDs.
- All malformed inputs fail before local effect creation.

## Commit boundary

`refactor(contracts): establish one canonical command and identity protocol`

---

# Milestone 3 — Make durable orchestration the sole kernel effect owner

## Goal

Delete the direct provider/effect loop from `KernelDaemon` instead of patching it.

## Structural target

```text
Kernel composition root
  ├── CommandConsumer
  ├── LocalHarnessRuntime / OrchestrationEngine
  ├── ProviderReactor
  ├── WorkspaceReactor
  ├── CheckpointReactor
  ├── ProjectionPublisher
  ├── MachineHeartbeat
  └── ShutdownCoordinator
```

## Changes

Modify:

- `packages/orchestration/src/orchestration-engine.ts`
- `packages/orchestration/src/reactor-registry.ts`
- add focused reactors under `packages/orchestration/src/reactors/`
- `packages/harness-runtime/src/local-harness-runtime.ts`
- `packages/local-store/src/effect-store.ts`
- `packages/local-store/src/event-store.ts`
- `apps/daemon/src/kernel-daemon.ts`
- `apps/daemon/src/index.ts`

Requirements:

- Register provider, workspace, checkpoint, approval, and projection reactors.
- Persist command receipt, canonical events, snapshot, effect intent, and projection outbox row atomically.
- Drain durable effects through the orchestration engine.
- Remove direct provider execution from `KernelDaemon`.
- Do not execute a provider after `sendTurn` returns a duplicate receipt.
- Make required event append failures fail the operation; never log-and-report-success.
- Place each claimed command behind an independent failure boundary.
- Keep `KernelDaemon` below 1,000 lines and reduce it materially; target a small composition/lifecycle module rather than splitting the same switch across arbitrary helpers.

## Remote lease protocol

Modify:

- `convex/commands/inbox.ts`
- `apps/daemon/src/sync/convex-command-source.ts`
- command consumer module extracted from `kernel-daemon.ts`

Requirements:

- Claim only work that can start.
- Renew the exact lease generation throughout external-effect execution.
- Fence local completion by lease generation.
- Stop/fence work when renewal is lost.
- Separate local durable completion from retryable remote acknowledgement.
- Redelivery resumes/reconciles the existing durable effect instead of invoking it again.

## Tests

- Duplicate delivery after daemon restart produces one provider start.
- Lease expiry during a long turn does not duplicate execution.
- Lost Convex completion response converges.
- Kill after local persist but before provider start recovers.
- Kill after provider acceptance but before local completion recovers/fails deterministically.
- One command acknowledgement failure does not abandon the rest of a claimed batch.
- Completed turns have no pending provider effects.

## Exit criteria

- There is one effect execution path.
- `KernelDaemon` contains no direct provider workflow switch.
- Exactly-once local command effects are proven under restart and redelivery.

## Commit boundaries

1. `refactor(kernel): route effects through durable reactors`
2. `fix(kernel): renew and fence remote command leases`
3. `refactor(kernel): reduce daemon to lifecycle composition`

---

# Milestone 4 — Implement ordered projection publication

## Goal

Make local canonical history converge safely into Convex.

## Changes

Add:

- `apps/daemon/src/sync/projection-publisher.ts`
- `apps/daemon/src/sync/projection-publisher.integration.test.ts`

Modify:

- `packages/local-store/src/outbox.ts`
- `packages/local-store/src/event-store.ts`
- `apps/daemon/src/sync/convex-projection-sink.ts`
- `convex/projections/publish.ts`
- `convex/schema.ts`
- `apps/daemon/src/kernel-daemon.ts`

Requirements:

1. Claim bounded local outbox rows under a lease.
2. Group by run while preserving per-run sequence.
3. Publish only the next contiguous event range.
4. Treat exact duplicate events as success.
5. Reject identity conflicts and gaps.
6. Advance the remote projection cursor only after durable event publication.
7. Publish snapshots only through the confirmed cursor.
8. Acknowledge local rows only after durable remote success.
9. Retry lost responses safely.
10. Surface backlog, oldest-row age, retries, gaps, and divergence as health signals.

Convex must validate stable owner, machine, and project identity across the complete run stream. Existing snapshots must not jump across missing event ranges.

## Tests

Inject:

- duplicate event writes;
- reordered batches;
- partial success;
- lost response after commit;
- daemon restart before local acknowledgement;
- stale outbox lease;
- snapshot jump over a gap;
- cross-project or cross-machine continuation;
- corrupt event payload.

Assertions:

- remote events equal the local contiguous prefix;
- snapshots never lead events;
- cursor never regresses;
- exact duplicates do not create duplicate history;
- divergent identities fail closed.

## Exit criteria

- Fresh nonzero-sequence runs publish successfully.
- Outbox reaches zero after recovery.
- Browser reconnect from any confirmed cursor observes no gap or duplicate.

## Commit boundary

`feat(sync): publish ordered kernel events through the durable outbox`

---

# Milestone 5 — Close execution and application security boundaries

## Goal

Ensure no kernel or legacy execution path bypasses enforced policy.

## 5.1 Sandbox all provider-originated execution

Modify:

- `apps/daemon/src/tools.ts`
- `apps/daemon/src/governed-tool-executor.ts`
- `packages/workspace-runtime/src/sandbox/sandbox-executor.ts`
- platform sandbox adapters
- daemon composition in `apps/daemon/src/index.ts`

Requirements:

- Route every provider-originated process through `SandboxExecutor`.
- Clear inherited environment except for an explicit allowlist.
- Fail closed when required confinement is unavailable.
- Replace permissive unknown-command classification with explicit capability enforcement.
- Ensure kernel mode receives and requires a sandbox executor.

## 5.2 Prevent filesystem symlink escape

Modify:

- `apps/daemon/src/tools.ts`
- filesystem helper modules

Requirements:

- Canonicalize root and existing ancestors with `realpath`.
- Reject symlink traversal outside the workspace.
- Use no-follow/openat-style operations where available.
- Defend against symlink replacement races for writes.

## 5.3 Fix pairing takeover

Modify:

- `convex/pairing.ts`
- `convex/machines.ts`
- `convex/schema.ts`
- pairing tests

Requirements:

- Pairing code creation is create-only; collision is rejected.
- Bind pairing to an additional device-held nonce.
- Consume the exact pairing atomically during registration.
- Rate-limit start, claim, and registration attempts.
- Store only hashed device secrets in Convex.

## 5.4 Scope role mutation

Modify:

- `convex/subagents.ts`
- `convex/schema.ts`
- subagent authorization tests

Choose one:

- owner/project-scoped roles, or
- internal/admin-only global roles.

No authenticated tenant may mutate execution prompts or capabilities used by another tenant's daemon.

## 5.5 Lock down narrowing and operator functions

Modify:

- `convex/narrow.ts`
- `convex/schema_narrow.ts`
- `convex/migrations.ts`

Requirements:

- Make narrowing internal-only.
- Verify a server-stored rehearsal hash.
- Do not expose deployment-wide counts/run IDs to unauthenticated callers.
- Keep live destructive behavior disabled until Milestone 9.

## Tests

- Python/Perl/shell-expansion sandbox bypass attempts.
- Credential and `/proc/*/environ` reads.
- Network access by permission profile.
- Workspace symlink to `~/.ssh` for read and write.
- Pairing collision/overwrite attack.
- Cross-owner role update.
- Unauthenticated/operator-function access.
- Oversized/secret-bearing command payloads.

## Exit criteria

- Security review reports no unresolved P0/P1 findings.
- Security gate exercises real enforcement, not only regex patterns.

## Commit boundaries

1. `security(daemon): enforce sandboxed provider execution and safe paths`
2. `security(convex): harden pairing and role ownership`
3. `security(convex): make migration and narrowing operator-only`

---

# Milestone 6 — Harden the self-hosted backend and backup lifecycle

## Goal

Make the selected self-hosted topology reproducible and recoverable.

## Changes

Add or modify:

- `scripts/install-self-hosted-convex.sh`
- `scripts/verify-self-hosted-convex.ts`
- `scripts/backup-self-hosted-convex.sh`
- `scripts/restore-self-hosted-convex.sh`
- `docs/operations/self-hosted-convex.md`
- `docs/operations/backup-recovery.md`
- `convex/auth.config.ts`
- `apps/daemon/src/backup.ts`

Requirements:

- Pin the Convex backend version and checksum.
- Record backend build/version even if `/version` reports `unknown`.
- Do not pass the instance secret through process arguments when a safer supported mechanism exists.
- Define JWT/JWKS/SITE_URL ownership and rotation behavior.
- Back up the complete backend data root, file storage, compatible binary/version manifest, and required auth/instance secrets under the approved secret policy.
- Back up daemon-local SQLite/WAL state separately.
- Restore into an isolated staging deployment and verify integrity before declaring backup success.

## Restore acceptance

After restore, prove:

- schema/functions deploy;
- sign-in works;
- existing session policy is understood;
- pairing and machine ownership work;
- file storage is present;
- daemon reconnects;
- local SQLite reopens;
- projection/event cursors reconcile;
- no secret appears in logs or argv.

## Exit criteria

- Automated backup succeeds.
- Automated staging restore succeeds.
- Restore evidence includes checksums, backend version, schema version, and test run ID.

## Commit boundary

`feat(ops): pin, back up, restore, and verify self-hosted Convex`

---

# Milestone 7 — Resolve and execute historical data migration

## Goal

Implement only the approved D2 branch.

## If D2-A: migrate hosted history

Add or modify:

- `scripts/export-hosted-convex-data.ts`
- `scripts/verify-convex-history-export.ts`
- `scripts/import-convex-history.ts`
- `convex/migrations.ts`
- `convex/migrations.convex.test.ts`
- `convex/schema.ts`
- projection modules

Requirements:

- Inventory tables, counts, owners, active runs, file storage, auth identities, and references.
- Prove the export/import mechanism on disposable deployments first.
- Define source-ID to destination-ID mapping.
- Preserve owner/project/machine/thread/run provenance.
- Explicitly handle auth re-enrollment and session invalidation.
- Process bounded cursor pages with persisted progress.
- Mark each imported source record with migration version/provenance.
- Make reruns idempotent.
- Quiesce or fence hosted writes during final cutover.
- Verify counts, checksums, ownership, references, complete history, and active-run disposition.

Replace the current fixed `take(100)`/truncated migration. Verification must cover all rows, not a sample.

## If D2-B or D2-C

- Document archive/retention or fresh-start semantics.
- Create a new self-hosted account/pairing procedure.
- Ensure UI and docs do not imply historical continuity.
- Preserve any legally or operationally required audit export.

## Exit criteria

- Approved historical-data outcome is documented and rehearsed.
- Final cutover has immutable pre-cutover backups.
- Migration rerun produces no changes.
- No active run is silently lost or double-executed.

## Commit boundary

`feat(migration): execute approved hosted history transition`

---

# Milestone 8 — Add live self-hosted acceptance and shadow parity

## Goal

Test the real topology and prove kernel behavior without giving it effect ownership.

## Live integration harness

Add:

- `scripts/start-self-hosted-convex.ts`
- `scripts/stop-self-hosted-convex.ts`
- `apps/daemon/src/self-hosted-convex.e2e.test.ts`
- `apps/daemon/src/production-acceptance.e2e.test.ts`
- browser acceptance tests under `apps/web/e2e/`
- CI profile in `.github/workflows/ci.yml`

Requirements:

- Use a pinned backend and isolated temporary data directory.
- Deploy real Convex functions.
- Configure test JWT/auth values.
- Use fake providers in ordinary CI; real provider smoke remains protected/opt-in.
- Never touch developer or production data.

Scenarios:

- signup/signin;
- pairing and machine registration;
- heartbeat for more than 60 seconds;
- owner-scoped project/run access;
- command delivery;
- ordered projections;
- steering and stop;
- approval allow/deny;
- checkpoint capture/restore;
- daemon restart;
- backend restart;
- lost response;
- lease expiry;
- duplicate delivery;
- browser reconnect from cursor;
- backup/restore smoke.

## Real shadow mode

Modify/add:

- `apps/daemon/src/index.ts`
- `apps/daemon/src/shadow/shadow-runtime.ts`
- `apps/daemon/src/shadow/projection-comparator.ts`
- `packages/orchestration/src/shadow-runner.ts`

Requirements:

- Legacy remains the only effect owner.
- Shadow consumes captured/normalized inputs with no-op/fake effect adapters.
- Compare messages, state transitions, approvals, usage, diffs, checkpoints, and terminal status.
- Persist divergence evidence.
- Do not construct an unused `KernelDaemon` and call that shadowing.

## Exit criteria

- Live backend suite passes repeatedly.
- Shadow reports zero unexplained state-machine divergence.
- Zero duplicate effects.
- Zero cross-owner results.
- Projection backlog returns to zero.

## Commit boundaries

1. `test(self-hosted): exercise real Convex backend and daemon recovery`
2. `feat(shadow): compare kernel decisions without duplicate effects`

---

# Milestone 9 — Browser cutover, canary rollout, and eventual narrowing

## Goal

Cut over reads and writes only after every prior gate passes.

## 9.1 Browser runtime cutover

Modify:

- `apps/web/src/run-data.ts`
- `apps/web/src/thread-view.tsx`
- `apps/web/src/canonical-runtime.ts`
- `apps/web/src/canonical-runtime.test.ts`
- browser runtime hooks/components
- `packages/client-runtime/`

Requirements:

- Submit shared command envelopes through the canonical command boundary.
- Consume snapshot plus ordered events.
- Resume from cursors.
- Detect gaps and refuse to show plausible-but-incomplete state.
- Replace source-text tests with behavior tests.
- Cut over incrementally behind a reversible runtime flag.

## 9.2 Canary rollout

Order:

1. Developer machine opt-in.
2. Internal canary machines.
3. Small production canary.
4. Kernel default with explicit legacy rollback.
5. One complete release window with legacy still available.

Required telemetry:

- runtime activations;
- command lease renewal failures;
- duplicate/conflicting command IDs;
- active/pending effects;
- projection backlog and age;
- sequence gaps/divergence;
- auth failures;
- sandbox denials/failures;
- recovery and restart outcomes;
- legacy fallback activations.

## 9.3 Production topology deployment

Modify only after D1 is approved:

- `.github/workflows/deploy-production.yml`
- `.github/workflows/release.yml`
- `docs/production-deployment.md`
- topology-specific service/ingress files

The workflow must deploy exactly the documented topology and run a post-deploy functional smoke.

## 9.4 Narrowing

Narrowing is a separate later release.

Preconditions:

- kernel default for one full release window;
- zero unexplained invariant violations;
- zero required legacy activations;
- all active runs have ownership and contiguous projections;
- no outbox backlog;
- migration completion report verified;
- immutable backup recorded;
- staging restore of that backup passed;
- rollback procedure rehearsed;
- no unresolved P0/P1 correctness or security findings.

Only then:

- remove legacy-only workers and pollers;
- remove deprecated schema fields/tables;
- remove migration adapters;
- remove rollback aliases after the agreed support window.

## Commit boundaries

1. `feat(web): consume canonical snapshot and event runtime`
2. `feat(release): canary kernel runtime with legacy rollback`
3. `feat(deploy): align production workflow with approved topology`
4. `refactor(kernel): remove legacy runtime after release gate`
5. `refactor(convex): narrow schema after verified migration`

---

# 6. Cross-cutting verification matrix

| Invariant | Required test |
|---|---|
| Immutable command identity | Reuse one command ID with different run/kind/payload and require rejection |
| One provider effect | Redeliver after lease expiry and restart; assert one provider start |
| One filesystem effect | Kill around sandbox command and replay; assert one mutation |
| Lease fencing | Lose renewal and prove stale worker cannot commit |
| Atomic local state | Inject failure between receipt/event/snapshot/effect/outbox writes and prove rollback |
| Ordered projections | Duplicate, reorder, partially publish, and lose responses |
| Snapshot safety | Attempt to advance snapshot across a missing sequence and require rejection |
| Restart recovery | Kill at every durable boundary and prove deterministic recovery |
| Ownership | Wrong user/machine/project/run tests for every public boundary |
| Sandbox | Credential, network, interpreter, symlink, and unavailable-adapter tests |
| Pairing | Attacker overwrites observed pairing code; attack must fail |
| Migration | Resume every page, rerun idempotently, verify all source rows |
| Backup | Restore into staging and run auth/pairing/daemon/projection smoke |
| Browser reconnect | Resume at cursor without duplicate or gap |
| Legacy rollback | Flip one canary back to legacy without schema/data restoration |

# 7. Kill-point matrix

Automated failure injection must cover termination after:

1. Convex command claim.
2. Local command receipt persistence.
3. Local effect creation.
4. Remote lease renewal.
5. Provider process/session start.
6. First provider delta.
7. Approval request.
8. Sandbox command start.
9. Checkpoint ref creation.
10. Projection event remote commit.
11. Projection snapshot remote commit.
12. Local outbox acknowledgement.
13. Graceful shutdown start.

After every restart, assert:

- no duplicate external effect;
- no sequence gap;
- no permanently leased command;
- no lost approval;
- no snapshot ahead of events;
- run is recoverable or terminal with a recorded reason.

# 8. Release gates

## Gate G0 — Baseline

- Typecheck, tests, conformance, build, bundle, and security pass.
- Legacy self-hosted daemon completes the soak without timeouts.

## Gate G1 — Canonical protocol

- One run ID and one command schema are enforced end to end.
- No vocabulary drift.

## Gate G2 — Durable kernel

- Direct provider execution is removed from `KernelDaemon`.
- Duplicate/restart/lease tests prove one effect.

## Gate G3 — Projection convergence

- Fault-injected outbox tests pass.
- Snapshot never leads event cursor.

## Gate G4 — Security

- No unresolved P0/P1 findings.
- Sandbox, symlink, pairing, role, and operator-boundary tests pass.

## Gate G5 — Operations

- Backend is pinned.
- Backup and staging restore pass.
- Supported service/ingress topology is documented.

## Gate G6 — Migration

- D2 outcome is executed and verified.
- All active runs and historical references are accounted for.

## Gate G7 — Live acceptance

- Real self-hosted backend suite passes.
- Shadow parity is clean.

## Gate G8 — Canary

- Zero duplicate effects, sequence gaps, cross-owner results, sandbox escapes, or unexplained divergence for the defined canary period.

## Gate G9 — Narrowing

- One kernel-default release window completed.
- Zero required legacy activations.
- Verified backup/restore and rollback evidence exists.

# 9. Recommended issue/PR breakdown

- **PRs 1–3 — Stabilize:** baseline verification/kernel freeze; independent heartbeat and shutdown; indexed legacy claims and latency metrics.
- **PRs 4–7 — Repair kernel correctness:** canonical commands/run identity; durable reactors; remote lease fencing; ordered projection publisher.
- **PRs 8–9 — Close security boundaries:** sandbox and safe paths; pairing, role ownership, and operator-function authorization.
- **PRs 10–13 — Prove operations:** pinned backend/backup/restore; approved history transition; live self-hosted integration; real shadow comparison.
- **PRs 14–17 — Cut over safely:** browser canonical runtime; canary/default rollout; post-gate legacy removal; separate final schema narrowing.

Every PR must include:

- invariant(s) changed;
- tests added;
- exact verification commands and results;
- migration/rollback impact;
- operational metrics affected;
- residual risks;
- proof that unrelated working-tree changes were not overwritten.

# 10. Definition of done

Relay may call the migration complete only when:

- the selected production topology is implemented and documented;
- the historical-data outcome is explicit and verified;
- legacy self-hosted operation is stable;
- the kernel has one durable effect owner;
- commands are lease-safe and replay-safe;
- projections converge through a durable ordered outbox;
- browser reads and writes use the canonical runtime;
- security boundaries fail closed;
- backup and restore are automated and rehearsed;
- live self-hosted, crash, security, browser, and canary suites pass;
- one release window completes with kernel default and zero required legacy activations;
- narrowing occurs only in a later release with verified rollback evidence.
