# Remaining Ticket Acceptance Criteria

Tickets that require external systems (Codex CLI, Convex deployment, platform tooling) or represent operational/deployment work. Each lists what must be true to mark the ticket done.

---

## Ticket 3 — Codex app-server provider adapter

**Blocked by:** Requires Codex CLI (`codex app-server`) installed in CI and developer environments.

- [ ] Generate and pin Codex TypeScript/JSON schemas (`codex app-server generate-ts` / `generate-json-schema`)
- [ ] Implement supervised stdio JSON-RPC transport (secrets off argv, bounded queues, process-loss handling)
- [ ] Normalize Codex thread/turn/item/approval/usage notifications to canonical events (table-driven, unknown→diagnostic)
- [ ] Implement ProviderDriver + ProviderSessionAdapter (startSession→thread/start, resume→thread/resume, etc.)
- [ ] Bridge Relay-owned tools and MCP servers through provider dynamic-tool or daemon-local stdio MCP adapter
- [ ] Opt-in real-Codex e2e smoke test (`RELAY_E2E_CODEX=1`, skipped in ordinary CI)

**Files:** `packages/providers/codex-app-server/src/`, `scripts/generate-codex-app-server-schema.ts`

---

## Ticket 12 — Route every workflow through the engine + reviewer jury

**Blocked by:** Tickets 11 (shadow parity), 6 (history), and requires modification of existing daemon workers.

- [ ] Move subagent workflow from `subagent-worker.ts` to orchestrated engine commands/events
- [ ] Move review workflow from ad-hoc coordination to orchestrated commands/events
- [ ] Move plan workflow from `plan-convex.e2e.test.ts` path to orchestrated commands/events
- [ ] Move MCP workflow through orchestrated commands/events
- [ ] Implement reviewer jury as an orchestrated workflow (reviewer + reviewer-security, different models → P0–P3 comments → "address findings" feed)
- [ ] No workflow state transitions happen outside the orchestration engine

---

## Ticket 14 — Operational reliability + observability

- [ ] Add structured local logs with correlation IDs joining browser→Convex→daemon→provider→tool→checkpoint
- [ ] Add metrics (run count, turn latency, event throughput, storage size) and health endpoint
- [ ] Add diagnostic export (anonymized state dump for debugging)
- [ ] Validate deterministic kill-point recovery at every lifecycle phase
- [ ] Implement retention/compaction/storage-pressure policy (auto-GC old events, snapshots, checkpoints)

---

## Ticket 15 — Security closure

- [ ] Write and test a threat model covering browser/Convex/daemon trust boundaries
- [ ] Harden secrets: tokens never on argv, credentials encrypted at rest
- [ ] Harden device identity: scoped tokens, minimal trust root
- [ ] Complete authorization semantics: owner/project/device scoping for all queries
- [ ] Complete audit semantics: every governance decision, command, and projection mutation is logged
- [ ] Run adversarial validation gate: authz matrix, sandbox escape suite, secret scanning, hostile-input corpus

---

## Ticket 16 — Distribution + operations

- [ ] Add daemon process supervisor (restart on crash, graceful shutdown, lease release)
- [ ] Implement version compatibility checks and safe upgrades (post-migration schema awareness)
- [ ] Implement backup, restore, and corruption recovery (rehearsed)
- [ ] Produce signed, versioned artifacts with one-command install/upgrade/uninstall
- [ ] Write operator runbook

---

## Ticket 17 — Performance, conformance, production acceptance

- [ ] Establish service-level objectives and load profiles
- [ ] Optimize from measured signals: bounded batches, lean projections, no hot pollers
- [ ] Run supported OS conformance matrix (Linux/macOS/Windows)
- [ ] Run provider conformance matrix (Codex app-server + deterministic fake)
- [ ] Execute the production acceptance scenario on the supported OS matrix

---

## Ticket 18 — Narrow schemas + remove legacy runtime

**Blocked by:** Tickets 13, 17. Irreversible — must be last.

- [ ] Verify at least one release window on kernel-default with zero legacy activations
- [ ] Verify backup/rollback rehearsal completed and recorded
- [ ] Narrow widened Convex schemas (remove dual-write columns, legacy tables if unused)
- [ ] Remove legacy daemon code (agent-loop.ts, per-work-type pollers, raw-llm adapter)
- [ ] Remove RELAY_RUNTIME_MODE flag and kernel-cutover gating
- [ ] Record release evidence (dry-run logs, verification output, rehearsal results)
