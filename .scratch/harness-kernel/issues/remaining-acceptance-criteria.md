# Remaining Ticket Acceptance Criteria

Tickets that require external systems (Codex CLI, Convex deployment, platform tooling) or represent operational/deployment work. Each lists what must be true to mark the ticket done.

Audit note (2026-07-23): checked items below are closed by committed code and
local evidence. Items that remain open are intentionally external or
irreversible gates; deterministic local coverage is not substituted for them.

---

## Ticket 3 — Codex app-server provider adapter

**Blocked by:** Requires Codex CLI (`codex app-server`) installed in CI and developer environments.

- [x] Generate and pin Codex TypeScript/JSON schemas (`codex app-server generate-ts` / `generate-json-schema`) (`scripts/codex-schema.ts`, 267 checked-in JSON schemas, pinned `0.144.3`)
- [x] Implement supervised stdio JSON-RPC transport (secrets off argv, bounded queues, process-loss handling) (`packages/providers/codex-app-server/src/codex-transport.ts` and transport tests)
- [x] Normalize Codex thread/turn/item/approval/usage notifications to canonical events (table-driven, unknown→diagnostic) (`normalize-event.ts`, `normalize-request.ts`, 46 provider tests)
- [x] Implement ProviderDriver + ProviderSessionAdapter (startSession→thread/start, resume→thread/resume, etc.) (`codex-driver.ts`, `codex-session-adapter.ts`)
- [x] Bridge Relay-owned tools and MCP servers through provider request resolution (`codex-driver.ts` exposes the durable resolver; daemon MCP/governance bridge is covered by kernel wiring tests)
- [ ] Opt-in real-Codex e2e smoke test (`RELAY_E2E_CODEX=1`, skipped in ordinary CI)

**Files:** `packages/providers/codex-app-server/src/`, `scripts/generate-codex-app-server-schema.ts`

---

## Ticket 12 — Route every workflow through the engine + reviewer jury

**Blocked by:** Tickets 11 (shadow parity), 6 (history), and requires modification of existing daemon workers.

- [x] Move subagent workflow from `subagent-worker.ts` to orchestrated engine commands/events (kernel workflow reactor and durable task lease)
- [x] Move review workflow from ad-hoc coordination to orchestrated commands/events (reviewer jury durable child executions)
- [x] Move plan workflow from `plan-convex.e2e.test.ts` path to orchestrated commands/events (kernel plan workflow regression)
- [x] Move MCP workflow through orchestrated commands/events (canonical elicitation/task activity regressions)
- [x] Implement reviewer jury as an orchestrated workflow (reviewer + reviewer-security, different models → P0–P3 comments → "address findings" feed)
- [x] No workflow state transitions happen outside the orchestration engine for the kernel path; legacy adapters remain only as the explicit rollback boundary

---

## Ticket 14 — Operational reliability + observability

- [x] Add structured local logs with correlation IDs joining browser→Convex→daemon→provider→tool→checkpoint
- [x] Add metrics (run count, turn latency, event throughput, storage size) and health endpoint
- [x] Add diagnostic export (anonymized state dump for debugging)
- [x] Validate deterministic kill-point recovery at every lifecycle phase (`run-crash-matrix.ts`, 58/58 passed locally)
- [x] Implement retention/compaction/storage-pressure policy (auto-GC old events, snapshots, checkpoints)

---

## Ticket 15 — Security closure

- [x] Write and test a threat model covering browser/Convex/daemon trust boundaries
- [x] Harden secrets: tokens never on argv, credentials encrypted at rest — device tokens are hashed/scoped in Convex and stored through macOS Keychain, Linux Secret Service (`secret-tool`), or Windows user-scoped DPAPI; legacy plaintext metadata migrates on load and unavailable stores fail closed (`apps/daemon/src/device-credentials.ts`)
- [x] Harden device identity: scoped tokens, minimal trust root
- [x] Complete authorization semantics: owner/project/device scoping for all queries
- [x] Complete audit semantics: every governance decision, command, and projection mutation is logged with actor, correlation/causation, requested/effective scope, and policy version
- [x] Run adversarial validation gate: authz matrix, sandbox escape suite, secret scanning, hostile-input corpus (`security:gate`, sandbox/authz suites, and daemon security tests)

---

## Ticket 16 — Distribution + operations

- [x] Add daemon process supervisor (restart on crash, graceful shutdown, lease release)
- [x] Implement version compatibility checks and safe upgrades (post-migration schema awareness)
- [x] Implement backup, restore, and corruption recovery (rehearsed)
- [x] Produce signed, versioned artifacts with one-command install/upgrade/uninstall (signed checksums, release metadata, verified installers, and published uninstallers)
- [x] Write operator runbook

---

## Ticket 17 — Performance, conformance, production acceptance

- [x] Establish service-level objectives and load profiles
- [x] Optimize from measured signals: bounded batches, lean projections, no hot pollers
- [ ] Run supported OS conformance matrix (Linux/macOS/Windows) — the matrix is wired in `.github/workflows/ci.yml`; hosted CI execution remains required
- [ ] Run provider conformance matrix (Codex app-server + deterministic fake) — fake provider passes locally; credentialed Codex remains protected
- [ ] Execute the production acceptance scenario on the supported OS matrix — deterministic Linux acceptance passes locally; hosted OS rows remain required

---

## Ticket 18 — Narrow schemas + remove legacy runtime

**Blocked by:** Tickets 13, 17. Irreversible — must be last.

- [ ] Verify at least one release window on kernel-default with zero legacy activations
- [ ] Verify backup/rollback rehearsal completed and recorded
- [ ] Narrow widened Convex schemas (remove dual-write columns, legacy tables if unused)
- [ ] Remove legacy daemon code (agent-loop.ts, per-work-type pollers, raw-llm adapter)
- [ ] Remove RELAY_RUNTIME_MODE flag and kernel-cutover gating
- [ ] Record release evidence (dry-run logs, verification output, rehearsal results)
