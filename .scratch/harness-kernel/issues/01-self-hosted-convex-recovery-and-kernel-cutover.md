# Self-Hosted Convex Recovery and Kernel Cutover

Type: task
Status: claimed

## Problem Statement

Relay became unreliable after moving from hosted Convex to a self-hosted Convex backend. The daemon regularly approaches or exceeds Convex function-duration limits, reports claim and heartbeat errors, and does not provide a trustworthy indication that the system is healthy. The current documentation and production automation also describe conflicting hosted and self-hosted deployment models.

The deeper problem is that the harness kernel is not yet a complete end-to-end execution path. The daemon-local SQLite/WAL store and orchestration engine contain the intended durable primitives, but the active kernel composition bypasses some of them. Commands can outlive their Convex leases, duplicate delivery can repeat provider effects, command vocabularies and run identities differ between tiers, and the projection outbox is not fully published into ordered Convex projections. The browser still relies on legacy thread workflows, so enabling kernel mode does not constitute a working cutover.

Migration and recovery are also unsafe. The current backfill is bounded to samples rather than resumable across the complete deployment, narrowing checks do not prove full parity or backup readiness, and there is no approved decision for hosted historical data. Security boundaries around process execution, filesystem paths, pairing, shared roles, and operator-only migration functions must be closed before kernel execution can become authoritative.

From the user's perspective, Relay must become boring and predictable: the local backend starts reliably, the daemon stays online, a command executes once, state survives restarts, the browser reconnects without gaps, and operators can back up, restore, migrate, canary, and roll back without losing history or duplicating work.

## Solution

Relay will recover the self-hosted legacy runtime first, then complete the kernel through additive, reversible stages.

The legacy runtime remains the default and only effect owner until all release gates pass. Machine heartbeat becomes independent from project reconciliation. Legacy claim paths become indexed, bounded, and observable so the self-hosted backend stays below its execution limits.

The kernel will use one canonical command and event model across the client, Convex, daemon, and local store. A canonical run identifier will be allocated before run creation and remain stable across every tier. Convex will act as authenticated remote-command ingress and browser-facing projection storage. The daemon and its local SQLite/WAL store will remain authoritative for execution state, provider sessions, workspaces, command receipts, canonical events, effects, checkpoints, and the projection outbox, consistent with ADRs 0001–0003.

Direct provider execution will be removed from the kernel composition root. The orchestration engine and durable reactors will be the sole owners of provider, workspace, checkpoint, approval, and projection effects. Convex command leases will be renewed and generation-fenced for the complete effect lifetime. Redelivery will resume or reconcile a persisted effect rather than start another one.

A dedicated projection publisher will claim local outbox rows, publish each run's next contiguous canonical events, advance the projection cursor only after durable acknowledgement, publish snapshots only through the confirmed event prefix, and then acknowledge local rows. Duplicate, reordered, partial, and lost-response deliveries will converge without gaps or duplicate history.

All provider-originated process and filesystem activity will pass through enforced sandbox and path boundaries. Pairing codes will be collision-safe and device-bound. Role mutation will be tenant-scoped or operator-only. Migration and narrowing operations will be internal, authenticated, rehearsal-gated operations.

The project will explicitly decide its production Convex topology, supported operating systems, and hosted-history outcome. Self-hosted backend installation will pin a version and checksum. Backup and restore will include the complete Convex data root, required credentials under the approved secret policy, and daemon-local SQLite state. Hosted-history migration, if required, will be cursor-driven, idempotent, provenance-preserving, and verified on disposable deployments before final cutover.

The primary acceptance seam will be one cross-tier scenario:

**Client test driver → real isolated self-hosted Convex → authenticated command inbox → daemon command source → local SQLite/WAL orchestration and deterministic provider/workspace reactors → durable projection publisher → Convex ordered projections → ClientRuntime disconnect/reconnect.**

The existing `HarnessRuntime` contract remains the lower-level conformance seam for fast, deterministic validation of fake, local durable, and protected real-provider implementations. Browser behavior tests will sit above the cross-tier seam only after the command/projection document boundary is green.

Kernel rollout will proceed through real shadow comparison, developer opt-in, internal canary, small production canary, kernel default with explicit legacy rollback, and one complete release window. Legacy removal and schema narrowing will happen only in later, separate releases after parity, security, backup/restore, migration, and rollback evidence is complete.

## User Stories

1. As a Relay developer, I want the self-hosted Convex backend and daemon to start predictably, so that local development does not depend on unexplained terminal state.
2. As a Relay developer, I want backend startup and function deployment to be clearly separate operations, so that I can diagnose whether the server or deployed functions are failing.
3. As a Relay developer, I want the backend version and application deployment version recorded, so that I can reproduce compatibility problems.
4. As a Relay developer, I want the backend binary pinned and checksummed, so that an unannounced latest release cannot break my environment.
5. As a Relay developer, I want web, daemon, and persisted pairing URLs checked for alignment, so that all clients use the intended deployment.
6. As a Relay developer, I want changing deployments to require an explicit re-pairing flow, so that stored credentials cannot silently override my intended target.
7. As a Relay user, I want a running daemon to remain visibly online when my project list does not change, so that liveness does not depend on configuration updates.
8. As a Relay operator, I want heartbeat and project reconciliation to be independent, so that one responsibility cannot suppress the other.
9. As a Relay operator, I want overlapping heartbeat calls prevented, so that liveness updates do not create avoidable contention.
10. As a Relay operator, I want revoked device credentials to stop the daemon safely, so that a revoked machine cannot continue claiming work.
11. As a Relay developer, I want claim operations to use bounded indexed eligibility, so that self-hosted Convex functions remain below execution limits.
12. As a Relay operator, I want p50, p95, and p99 claim latency metrics, so that degradation is visible before hard timeouts occur.
13. As a Relay operator, I want timeout and OCC failures surfaced as health signals, so that repeated backend retries are not mistaken for healthy operation.
14. As a Relay developer, I want one canonical command vocabulary, so that Convex cannot accept commands the daemon always rejects.
15. As a Relay developer, I want command payloads validated by the same contract at every ingress seam, so that tiers cannot interpret the same command differently.
16. As a Relay operator, I want malformed and oversized command payloads rejected before local persistence or effect execution, so that untrusted input cannot consume unbounded resources.
17. As a Relay user, I want one stable run identity across browser, Convex, daemon, SQLite, and projections, so that follow-up commands reach the run I created.
18. As a Relay user, I want run creation, resume, turn submission, steering, interruption, approval, checkpoint, and stop commands to work through one protocol, so that runtime mode does not change supported behavior unexpectedly.
19. As a Relay developer, I want a duplicate command identifier to mean one immutable command envelope, so that retries are safe and conflicting intent is rejected.
20. As a Relay user, I want network retries to return the original command receipt, so that a lost response does not repeat my action.
21. As a Relay user, I want a long provider turn to renew its remote command lease, so that another daemon cannot reclaim and execute it concurrently.
22. As a Relay operator, I want stale lease generations fenced from completion, so that an old worker cannot overwrite a newer claim.
23. As a Relay developer, I want remote acknowledgement retries separated from local durable completion, so that a transient Convex error does not repeat an external effect.
24. As a Relay user, I want provider work to execute once after daemon restart and redelivery, so that prompts, tool calls, and filesystem actions are not duplicated.
25. As a Relay developer, I want the orchestration engine to be the only command interpreter and effect owner, so that execution semantics do not diverge between duplicate loops.
26. As a Relay developer, I want provider actions executed through durable reactors, so that provider acceptance and completion can recover after process failure.
27. As a Relay developer, I want workspace actions executed through durable reactors, so that worktree state remains consistent with run state.
28. As a Relay developer, I want checkpoint actions executed through durable reactors, so that capture and restore can be retried safely.
29. As a Relay developer, I want approval resolution executed through the canonical state machine, so that stale or cross-run approvals cannot be applied.
30. As a Relay operator, I want a completed turn to have no pending provider effect, so that backlog accurately represents unfinished work.
31. As a Relay developer, I want deterministic provider event identifiers, so that duplicate native notifications normalize to one canonical event.
32. As a Relay user, I want every canonical event persisted in strict per-run sequence, so that replay reconstructs the same state.
33. As a Relay user, I want Convex projections to contain the complete contiguous event prefix, so that browser reconnect is trustworthy.
34. As a Relay user, I want snapshots to advance only after their corresponding events are durable, so that the UI never displays state that cannot be replayed.
35. As a Relay operator, I want projection cursor advancement to occur only after durable acknowledgement, so that lost responses can be retried safely.
36. As a Relay operator, I want duplicate projection batches accepted only when their identity and payload match exactly, so that retries converge without hiding corruption.
37. As a Relay operator, I want event gaps and identity conflicts rejected, so that divergent histories fail closed.
38. As a Relay operator, I want projection backlog size and oldest-row age measured, so that stalled publication is visible.
39. As a Relay user, I want the browser to resume from its last confirmed cursor without gaps or duplicates, so that reconnecting does not lose or repeat activity.
40. As a Relay user, I want the browser to refuse a sequence gap rather than render plausible incomplete state, so that displayed history remains trustworthy.
41. As a Relay developer, I want browser tests to assert behavior rather than source-string references, so that a legacy implementation cannot masquerade as a projection runtime.
42. As a Relay user, I want legacy mode to remain available during migration, so that I can roll back without restoring a database.
43. As a Relay operator, I want shadow mode to compare decisions without owning effects, so that parity can be measured without duplicate work.
44. As a Relay operator, I want shadow divergences persisted and classified, so that unexplained mismatches block promotion automatically.
45. As a Relay operator, I want canary rollout per machine, so that kernel risk is contained.
46. As a Relay operator, I want an explicit kernel kill switch, so that accidental enablement can be stopped independently of configuration drift.
47. As a Relay developer, I want kernel mode to avoid starting legacy claim pollers, so that there is exactly one effect owner.
48. As a Relay operator, I want all daemon timers, leases, providers, MCP processes, and stores closed on shutdown, so that restart does not leave stale work behind.
49. As a Relay user, I want provider-originated commands sandboxed by my effective permission profile, so that prompt injection cannot escape the workspace.
50. As a Relay operator, I want execution to fail closed when required sandbox enforcement is unavailable, so that security does not silently degrade.
51. As a Relay user, I want provider processes to receive only an explicit environment allowlist, so that daemon credentials are not inherited.
52. As a Relay user, I want filesystem reads and writes confined by canonical paths, so that repository symlinks cannot expose host files.
53. As a Relay developer, I want symlink replacement races considered for writes, so that path validation cannot be bypassed after checking.
54. As a Relay user, I want pairing-code collisions rejected, so that another device cannot replace my pending pairing.
55. As a Relay user, I want pairing bound to a device-held nonce, so that observing the human-readable code is insufficient to claim my account.
56. As a Relay operator, I want pairing attempts rate-limited, so that codes and registration endpoints cannot be brute-forced.
57. As a Relay tenant, I want role prompts and capabilities isolated by owner or project, so that another tenant cannot alter my daemon's behavior.
58. As a Relay operator, I want deployment-global role changes restricted to trusted administration, so that shared execution policy has a clear authority.
59. As a Relay operator, I want migration and narrowing functions internal and authenticated, so that ordinary users cannot invoke release operations.
60. As a Relay operator, I want rehearsal proofs checked against server-stored evidence, so that a caller cannot supply an arbitrary hash.
61. As a Relay operator, I want a production-topology decision recorded, so that deployment automation, TLS, ingress, and operator ownership agree.
62. As a Relay operator, I want the supported OS and sandbox matrix documented, so that unsupported enforcement is explicit.
63. As a Relay user, I want the hosted-history outcome documented, so that I understand whether my accounts and runs will migrate, remain archived, or start fresh.
64. As a Relay operator, I want hosted data inventoried before migration, so that owners, active runs, files, auth identities, and references are accounted for.
65. As a Relay operator, I want migration processed through persisted cursors, so that large deployments can resume after interruption.
66. As a Relay operator, I want migration records carry source provenance and version, so that reruns are idempotent and auditable.
67. As a Relay operator, I want final cutover writes quiesced or fenced, so that hosted and self-hosted deployments cannot both execute one active run.
68. As a Relay user, I want imported ownership and references verified, so that migrated history remains accessible only to the correct account.
69. As a Relay operator, I want a complete migration report rather than bounded samples, so that partial data cannot be declared complete.
70. As a Relay operator, I want the complete Convex data root and file storage backed up, so that recovery does not omit stored assets.
71. As a Relay operator, I want daemon-local SQLite/WAL state backed up separately, so that the execution authority can also be restored.
72. As a Relay operator, I want required instance and auth credentials included under the approved secret policy, so that restored data remains usable.
73. As a Relay operator, I want every backup restored into an isolated staging deployment, so that backup success is proven rather than assumed.
74. As a Relay operator, I want restored auth, pairing, machine ownership, file storage, daemon reconnect, and projection reconciliation tested, so that recovery covers the whole system.
75. As a Relay security reviewer, I want secrets absent from process arguments and logs, so that local users and diagnostic exports cannot recover administrator credentials.
76. As a Relay developer, I want a pinned isolated self-hosted backend fixture, so that CI tests the real server without touching developer data.
77. As a Relay developer, I want the fixture to deploy the actual application schema and functions, so that CLI and backend incompatibility is caught.
78. As a Relay developer, I want deterministic providers in ordinary cross-tier CI, so that reliability failures are reproducible and do not require external API credentials.
79. As a Relay maintainer, I want real provider acceptance in protected nightly or release jobs, so that provider integration is verified without making pull-request CI flaky.
80. As a Relay developer, I want fault injection at command claim, local persistence, effect execution, projection commit, acknowledgement, and shutdown, so that crash recovery is measured at every durable boundary.
81. As a Relay developer, I want tests synchronized through receipts, cursors, drain conditions, and health state, so that arbitrary sleeps do not conceal races.
82. As a Relay operator, I want backend restart tests, so that database process recovery is proven.
83. As a Relay operator, I want daemon restart tests, so that local execution recovery is proven.
84. As a Relay operator, I want lost-response tests, so that at-least-once transport converges without duplicate effects.
85. As a Relay operator, I want stale lease tests, so that generation fencing is proven.
86. As a Relay operator, I want backup and restore included in release acceptance, so that rollback is operationally credible.
87. As a Relay maintainer, I want test profiles named by the evidence they provide, so that local conformance is not mislabeled production acceptance.
88. As a Relay maintainer, I want exact commands, versions, run identifiers, and redacted logs stored as release evidence, so that a promotion decision is auditable.
89. As a Relay operator, I want kernel promotion blocked by unresolved P0 or P1 correctness and security findings, so that known critical risk cannot be waived silently.
90. As a Relay operator, I want one full kernel-default release window before legacy removal, so that rollback remains available during real usage.
91. As a Relay operator, I want zero required legacy activations before removal, so that the replacement has demonstrated behavioral coverage.
92. As a Relay operator, I want schema narrowing in a separate release, so that source rollback and data rollback are not coupled.
93. As a Relay operator, I want an immutable pre-narrow backup and verified restore hash, so that irreversible contraction has a tested recovery point.
94. As a Relay maintainer, I want obsolete direct loops and migration adapters deleted only after their replacement is proven, so that complexity is removed rather than permanently duplicated.
95. As a Relay user, I want the final system to survive network interruption, daemon restart, backend restart, and browser reconnect without losing or repeating my work, so that self-hosting is dependable.

## Implementation Decisions

- ADRs 0001, 0002, and 0003 remain authoritative. The harness kernel is adapter-first; daemon-local SQLite/WAL is the execution authority; Convex is authenticated command ingress and ordered browser-facing projection storage; canonical state changes occur through typed commands and append-only canonical events.
- `legacy` remains the default runtime and emergency rollback until every cutover gate passes. `shadow` cannot own provider, tool, workspace, checkpoint, or projection effects. `kernel` cannot become the default by merely changing configuration.
- The implementation begins by restoring a clean verification baseline and stabilizing the legacy self-hosted runtime. Kernel work does not excuse heartbeat, claim-latency, process-lifecycle, or test-entrypoint failures in the currently supported runtime.
- Machine heartbeat and project reconciliation are separate lifecycle services. Heartbeat runs independently, prevents overlap, retries with bounded backoff, and terminates safely on confirmed credential revocation.
- Growing claim queues use compound eligibility indexes and bounded reads. Claim selection avoids per-candidate document fan-out where eligibility can be represented directly. Poller staggering may remain as defense in depth but is not the primary scalability mechanism.
- One canonical command contract is shared by client submission, Convex validation, daemon deserialization, and local orchestration. Unsupported commands are rejected at ingress rather than admitted for later rejection.
- One canonical run identifier is allocated before run creation and remains stable across every tier. Legacy thread identifiers are not cast or silently treated as kernel run identifiers.
- Command identifiers are immutable identities. Exact replay returns the original command/receipt; any mismatch in actor, run, kind, correlation, or payload is rejected as a conflict.
- Command and payload size limits are explicit. Untrusted serialized input is validated before local persistence, state-machine admission, or effect creation.
- Provider/native event identifiers derive from stable provider instance, native session/turn identity, process generation, and notification identity. Wall-clock time and randomness are not used to distinguish duplicate native notifications.
- The local transaction atomically persists command receipt, canonical events, reduced snapshot, effect intents, and projection outbox rows. Partial success is not observable.
- The orchestration engine and durable reactors are the sole kernel effect owners. Provider, workspace, checkpoint, approval, and projection effects cannot be executed directly by the daemon composition root.
- The kernel composition root owns wiring and lifecycle only. It composes command consumption, local runtime, registered reactors, projection publication, heartbeat, diagnostics, and shutdown. It does not become a second workflow engine.
- Remote command claims use renewable generation-fenced leases. Work stops or is fenced when lease renewal is lost. Remote acknowledgement is retryable independently from local durable completion.
- Redelivery consults durable receipts/effects and resumes or reconciles existing work. It never starts an external effect solely because transport redelivered a command.
- Projection publication follows claim → contiguous event append → durable remote confirmation → cursor advance → snapshot publish through confirmed sequence → local acknowledgement.
- Projection event streams bind stable owner, machine, project, and run identity. Continuation cannot change those identities.
- Existing and new snapshots obey the same contiguous-prefix rule. A snapshot can never jump over missing events.
- Projection backlog, oldest pending age, retries, gaps, conflicts, and cursor lag are health and release signals.
- ClientRuntime remains the canonical client state seam. It consumes a snapshot plus strictly ordered events, persists the confirmed cursor, skips exact duplicates, and fails closed on gaps.
- Browser commands and rendering migrate incrementally behind a reversible boundary only after the cross-tier document contract passes. Source-text assertions are not accepted as cutover evidence.
- Provider-originated process execution always uses the platform sandbox executor and an explicit environment allowlist. Required confinement failure is fatal for the requested permission profile.
- Filesystem access uses canonical path/ancestor checks and no-follow semantics where available. Symlink traversal and replacement races are part of the threat model.
- Pairing creation is collision-safe, device-bound by an additional secret nonce, atomically consumed, hashed at rest, and rate-limited.
- Roles are owner/project-scoped or global mutations are internal/operator-only. Ordinary authenticated users cannot modify another tenant's prompts or capabilities.
- Migration, verification, backup, restore, and narrowing operations are internal/operator-controlled. Narrowing checks server-side rehearsal evidence and cannot be invoked by ordinary application users.
- Production topology, hosted-history disposition, and supported operating systems are explicit blocking decisions. Deployment automation and protected acceptance derive from those approved decisions rather than selecting defaults silently.
- Self-hosted backend artifacts are pinned and checksummed. Installation, service supervision, upgrade, health, and compatibility responsibilities are documented for the selected topology.
- Backup includes the complete Convex data root and file storage, compatible version manifest, required credentials under the approved policy, and daemon-local SQLite/WAL state. Backup completion requires an isolated staging restore.
- Hosted-history migration, if selected, is bounded, cursor-driven, provenance-preserving, idempotent, ownership-aware, and verified across the complete source. A fresh-start or archive decision is documented explicitly if migration is not selected.
- The primary cross-tier acceptance seam is the user-confirmed command/projection/recovery path through a real isolated self-hosted backend and deterministic effects. The existing HarnessRuntime black-box contract remains the lower-level conformance seam.
- Real provider acceptance is protected and opt-in for nightly/release runs. Ordinary cross-tier CI uses deterministic provider and workspace fixtures.
- Shadow mode captures equivalent legacy inputs, evaluates kernel decisions with no-op effects, and compares normalized critical outcomes. Unexplained divergence blocks promotion.
- Rollout is developer opt-in → internal canary → small production canary → kernel default with explicit legacy rollback → one full release window.
- Legacy removal and schema narrowing are separate later releases. They require zero necessary legacy activations, complete migration/parity, no projection backlog, verified backup/restore, rehearsed rollback, and no unresolved P0/P1 findings.

## Testing Decisions

- Good tests assert externally observable commands, receipts, canonical events, snapshots, cursors, terminal states, ownership outcomes, and filesystem/Git effects. They do not assert private class structure, SQL statements, timer implementation, source strings, or provider-native payload shapes.
- The primary acceptance seam is the single cross-tier command/projection/recovery scenario approved by the user: a client driver submits commands to a real isolated self-hosted Convex deployment; the daemon consumes them into local durable orchestration; deterministic reactors produce effects; the projection publisher returns ordered state to Convex; ClientRuntime disconnects and resumes from its cursor.
- The existing HarnessRuntime contract remains the fast lower-level seam. The same black-box lifecycle contract runs against the deterministic fake and local durable runtime, with protected real-provider conformance where appropriate.
- Existing local-store integration tests remain the authority for transactional receipt/event/snapshot/effect/outbox atomicity, stale stream versions, corruption handling, durable leases, and reopen/replay behavior.
- Existing orchestration integration tests remain the authority for per-run serialization, bounded cross-run concurrency, duplicate delivery, effect leasing, approval gating, internal result commands, and deterministic state transitions.
- Existing Convex tests remain the authority for authenticated ownership, transactional inbox/projection rules, exact duplicate behavior, gap rejection, cursor monotonicity, and bounded queries. They supplement but do not replace live-backend testing.
- Existing ClientRuntime tests remain the authority for snapshot-plus-sequence application, duplicate skipping, gap failure, cursor resume, and terminal-state interpretation. A browser behavior test is added only after the live Convex document boundary passes.
- The cross-tier seam covers run creation, resume, turn send, streaming output, steering/interruption, approval allow/deny, checkpoint effect, ordered projection, client disconnect/reconnect, and terminal state.
- The cross-tier seam injects exact duplicate commands, conflicting duplicate commands, lease expiry, stale completion, daemon restart after claim/receipt/effect start, backend restart, duplicate projection batches, reordered projection batches, partial publication, and lost responses after durable remote commit.
- Cross-tier tests synchronize through durable receipts, effect drain status, projection cursors, and health conditions. Arbitrary sleeps are not accepted as correctness synchronization.
- The kill-point matrix covers remote claim, local receipt, effect creation, provider/session start, first delta, approval request, sandbox command, checkpoint creation, projection event commit, snapshot commit, local outbox acknowledgement, and shutdown.
- Every kill-point assertion requires one external effect, no event gap, no permanently leased command, no lost approval, no snapshot ahead of events, and a recoverable or terminal run with a recorded reason.
- Legacy self-hosted soak testing runs against a pinned real backend and measures heartbeat continuity, claim latency, timeouts, OCC failures, duplicate claims, and clean shutdown.
- Security tests attempt interpreter bypass, inherited credential access, private-network access, `/proc` reads, symlink read/write escape, symlink replacement, pairing overwrite, pairing brute force, cross-owner role mutation, forged run IDs, capability escalation, oversized payloads, secret-bearing projections, and unauthenticated operator calls.
- Backup testing is complete only after restore into an isolated deployment followed by schema deployment, auth, pairing, ownership, file-storage, daemon-local SQLite, reconnect, and projection reconciliation checks.
- Migration tests process multiple pages, stop and resume at every cursor boundary, rerun idempotently, verify source provenance and ownership, compare complete counts/checksums/references, and account for active runs.
- Shadow tests assert exactly one effect owner and compare normalized messages, activity, approvals, usage, diffs, checkpoints, and terminal state. Formatting-only differences require an explicit allowlist.
- Release evidence records backend version/checksum, application/schema version, topology profile, migration state, test run ID, exact verification commands, redacted logs, and residual risks.
- Pull-request CI runs typecheck, deterministic unit/integration suites, Convex tests, security gate, build/bundle checks, and the isolated self-hosted cross-tier seam where infrastructure permits.
- Nightly/release CI runs protected real-provider conformance, supported OS/sandbox matrix, process supervision, backup/restore, and production-topology acceptance.
- No test profile may be named production acceptance unless it crosses the approved production topology and validates the required recovery and security behavior.

## Out of Scope

- Replacing Convex with a different backend.
- Making Convex authoritative for provider process state, worktrees, local effects, or daemon recovery.
- Supporting kernel cutover before the specified correctness, security, migration, and operational gates pass.
- Deleting legacy workers, tables, fields, or rollback paths during additive widening and migration work.
- Running schema widening, data migration, browser read cutover, and narrowing in one deployment.
- Guaranteeing hosted-history continuity if the approved decision is archive or fresh start.
- Supporting an operating system or permission profile without enforceable documented sandbox behavior.
- Exposing provider-native protocol details to the canonical command/event model or browser.
- Making real external-provider credentials mandatory for ordinary pull-request CI.
- Redesigning Relay's visual language or unrelated product workflows.
- Solving multi-region high availability beyond the explicitly approved production topology.
- Treating poll-interval increases, larger leases, retries, or source-string tests as substitutes for the durable architecture.

## Further Notes

### Manual Outcome Demonstration

The published outcome was manually checked against the `to-spec` contract on 2026-07-22:

1. **Publication:** this document is present at the numbered harness-kernel issue path required by the repository issue-tracker convention.
2. **Triage:** the exact `Status: ready-for-agent` label is present near the top of the issue.
3. **Template:** all seven required sections are present: Problem Statement, Solution, User Stories, Implementation Decisions, Testing Decisions, Out of Scope, and Further Notes.
4. **Coverage:** the User Stories section contains 95 continuously numbered actor/feature/benefit stories covering users, developers, operators, tenants, security reviewers, and maintainers.
5. **Decision hygiene:** Implementation Decisions contains architectural and contract decisions without implementation file paths or code snippets.
6. **Architecture:** the language and decisions were manually compared with the domain glossary and ADRs 0001–0003; the spec preserves adapter-first `HarnessRuntime`, daemon-local authority, Convex command/projection responsibilities, immutable command receipts, and append-only canonical events.
7. **Testing seam:** the user explicitly selected the cross-tier self-hosted Convex command/projection/recovery seam as primary, with the existing `HarnessRuntime` contract retained as the lower seam; both are stated in Solution and Testing Decisions.
8. **Independent review:** a fresh-context evaluator inspected the published issue and repository conventions and returned `PASS` with no corrective findings.

The manual check demonstrates the requested outcome: the conversation and audit findings have been synthesized into a complete project spec, published in the local issue tracker, and marked ready for an implementation agent. This demonstration verifies specification publication and structure; it does not claim that the implementation described by the spec already exists.

- This spec uses the repository domain vocabulary: daemon, Convex command ingress, harness kernel, run, turn, canonical event, command receipt, projection outbox, projection cursor, snapshot, kill-point recovery, and widen-migrate-narrow.
- ADR 0001 defines the adapter-first HarnessRuntime and legacy/shadow/kernel migration model. ADR 0002 defines daemon-local authority and Convex projections. ADR 0003 defines canonical commands, immutable receipts, pure decision logic, and append-only events. Implementation must not contradict these decisions without a new superseding ADR.
- The current release posture remains NO-GO for kernel cutover, production self-hosting claims, and schema narrowing.
- The production topology, hosted-history outcome, and supported OS matrix remain explicit pre-production decisions, not implementation defaults.
- The highest-risk implementation mistake would be adding more branches to the existing kernel composition root rather than deleting its direct provider/effect ownership.
- The highest-risk migration mistake would be treating bounded samples as proof that all source history and ownership were migrated.
- The highest-risk operational mistake would be narrowing before a verified staging restore and one full kernel-default release window with no required legacy activations.
- Completion requires evidence from the cross-tier seam, the HarnessRuntime contract, security testing, crash recovery, migration verification, backup/restore, shadow parity, and canary telemetry.

## Comments

### 2026-07-22 — Manual publication verification

Manually opened the published issue and compared it with the `to-spec` template, the local issue-tracker conventions, the `ready-for-agent` triage vocabulary, the domain glossary, and ADRs 0001–0003.

Observed outcome:

- The spec is published as numbered issue `01` in the existing harness-kernel effort.
- The issue is labeled `Status: ready-for-agent`.
- Every required template section is present.
- The 95 user stories cover actors, requested behavior, and user/operator benefits.
- Implementation Decisions records architecture and contracts without volatile implementation file paths or code snippets.
- Testing Decisions records the user-approved cross-tier primary seam and existing `HarnessRuntime` lower seam.
- Problem, solution, scope, and release posture match the self-hosted Convex audit and implementation plan.

Manual verdict: **PASS — the requested conversation context was converted into a complete ready-for-agent spec and published to the project issue tracker.**
