# Relay v1 — Browser-Based Agentic Coding Platform

Status: ready-for-agent

## Problem Statement

Developers who run powerful local coding agents (like the Pi/Thanos harness) are chained to a terminal on one machine. Desktop agent apps (Codex Desktop, Cursor) solve the supervision problem — parallel threads, diff review, approvals — but require installing a heavy Electron app on every machine and can't be driven from a phone, tablet, or any browser. There is no lightweight way to supervise, steer, approve, and review local coding agents from anywhere, while keeping execution, code, and API keys on the developer's own machine.

## Solution

Relay: a browser-based control surface for local coding agents. A single compiled daemon runs on the developer's machine and owns everything that needs a real computer — the agent loop, filesystem, shell, git worktrees, governance, and API keys. A hosted web app (SPA) is the entire UI. Convex sits between them as the reactive backbone: the daemon dials out to Convex (no open ports), the browser subscribes to the same documents, and every message, event, diff, and approval flows through it — so the developer can open a browser anywhere, see all their machines and projects, run parallel agent threads on isolated git worktrees, review diffs with inline comments, approve risky actions, and ship commits. Layout and features follow the Codex Desktop app; the subagent roster and governance harness port from the user's Thanos setup. Extremely lightweight, fast, and powerful. No live preview — ever.

## User Stories

1. As a developer, I want to sign in to a web domain and see all my connected machines and their projects, so that I can work from any device without installing an IDE.
2. As a developer, I want a one-line installer for the daemon on Linux, macOS, and Windows, so that connecting a new machine takes under a minute.
3. As a developer, I want to pair a daemon to my account with a short pairing code, so that machine linking is secure without configuring ports, certificates, or tunnels.
4. As a developer, I want the daemon to make outbound-only connections, so that I never open inbound ports or configure my firewall.
5. As a developer, I want to see whether each machine is online via heartbeat status, so that I know where work can run right now.
6. As a developer, I want a projects sidebar with threads grouped under each project, so that I can multitask across projects the way Codex Desktop does.
7. As a developer, I want to start multiple parallel threads in one project, each on its own disposable git worktree, so that agents never step on each other's changes.
8. As a developer, I want to type a prompt in the browser and watch the agent's response stream in near real time, so that supervision feels immediate.
9. As a developer, I want every tool call the agent makes (reads, edits, commands) shown as typed activity in the thread, so that I can follow what it is doing at a glance.
10. As a developer, I want a command-stream terminal panel per thread that shows live output of every command the agent runs, so that I can verify behavior without SSH-ing in.
11. As a developer, I want to send one-off shell commands to a thread's worktree from the browser, so that I can check state or run tests myself mid-conversation.
12. As a developer, I want to review the thread's diff in a proper diff viewer, so that I can judge the work before it lands.
13. As a developer, I want to leave inline comments on specific lines of the diff that feed back into the agent's next turn, so that review is a conversation, not a rejection.
14. As a developer, I want to stage, commit, and push from the browser, so that shipping doesn't require switching tools.
15. As a developer, I want plan mode where one model writes the plan and another builds it, so that I get expensive-model judgment and fast-model execution.
16. As a developer, I want a plan artifact I can read and edit before the build starts, so that I stay in control of direction.
17. As a developer, I want a roster of declarative subagent roles (explorer, planner, oracle, reviewers, evaluator, builder, …) editable in the UI, so that I can tune how work is delegated without touching code.
18. As a developer, I want read-only subagents to run with hard edit/exec denies and fresh context, so that critics stay unbiased and safe by construction.
19. As a developer, I want writer subagents isolated in nested worktrees and returning typed result contracts, so that delegation is auditable and their output composable.
20. As a developer, I want per-role model routing with fallbacks (cheap models for recon, expensive for judgment), so that cost and quality are both optimized automatically.
21. As a developer, I want risky tool calls to pause the thread and render an approval card in my browser, so that I can allow or deny from wherever I am — including my phone.
22. As a developer, I want a policy file with allow/deny/ask rules over capabilities and risk tiers, so that routine actions never prompt me and dangerous ones always do.
23. As a developer, I want every governance decision written to an audit log, so that I can reconstruct exactly what was allowed, denied, and why.
24. As a developer, I want my API keys stored only on my machine and never in the cloud backend or browser, so that a compromise of the hosted service cannot leak my credentials.
25. As a developer, I want a provider-agnostic model catalog (Anthropic, OpenAI-compatible aggregators, etc.) with thinking levels and cost metadata, so that I can switch models freely.
26. As a developer, I want to connect MCP servers so agents can use external tools and data sources, so that the platform extends without bespoke integrations.
27. As a developer, I want per-thread token and cost tracking, so that I know what each piece of work costs before the bill surprises me.
28. As a developer, I want to steer or queue messages while a thread is running, so that I don't wait for a turn to finish to give direction.
29. As a developer, I want per-turn checkpoints of the worktree with one-click revert, so that a bad agent turn is an undo, not an archaeology dig.
30. As a developer, I want threads to survive daemon restarts and browser refreshes with full history, so that no work or context is ever lost.
31. As a developer, I want the web app to load fast and stay responsive with long threads (virtualized lists, lightweight editor), so that the tool never feels heavier than the work.
32. As a developer on Windows, I want the daemon to work natively with PowerShell, so that I don't need WSL.
33. As a security-conscious developer, I want subagent capabilities to only ever narrow from the parent's ceiling, so that delegation can never escalate privileges.
34. As a developer, I want commands and messages arriving through the cloud backbone treated as untrusted input by the daemon, so that a compromised account can't trivially own my machine.

## Implementation Decisions

All decisions below were grilled and individually approved.

1. **Execution: local host daemon.** The daemon owns filesystem, shell, git, and the agent loop. The browser executes nothing.
2. **Own agent loop.** The daemon implements its own loop — provider-agnostic LLM calls, tool execution, context management — rather than wrapping Pi/Codex CLI/Claude Code.
3. **Convex is the sole backbone and transport.** Daemon ⇄ Convex ⇄ browser. Thread state, messages, events, approvals, diffs, comments, commands all flow through Convex reactive queries. The daemon authenticates with a device token, subscribes to work queues, and writes batched updates. Token streams are batched (~100–200 ms flushes), never per-token mutations.
4. **Threads on disposable worktrees.** Each thread runs on a Codex-style managed git worktree: detached HEAD, created under the daemon's home directory, garbage-collected when done.
5. **Terminal is a command stream, not a PTY.** Agent-run command output streams live; users can send one-off commands. No interactive PTY in v1 (also avoids native-module pain on Windows).
6. **Subagents port the Thanos roster.** Declarative role definitions (name, description, tools, model, thinking level, max turns, context fresh|forked, read-only vs writer) stored in Convex and editable in the UI. Writers get nested worktrees; readers run fresh-context. Typed Subagent Result Contracts; large output spills to artifacts referenced by path. Depth cap 2.
7. **Governance ports the Thanos before-tool chokepoint.** Capability (read|edit|exec|task) × risk tier (low|high|critical) × policy rules → allow/deny/ask. "Ask" renders as a browser approval card. Per-subagent capability narrowing — each hop only narrows. All decisions audit-logged.
8. **Model catalog ports the Thanos models.json shape.** Provider-agnostic entries with API kind (anthropic-messages, openai-responses/completions), thinking-level maps, cost metadata, per-role routing with fallbacks. API keys live only in the daemon's local secrets store.
9. **Daemon: Bun + TypeScript.** Git via the git CLI (a checked prerequisite). Shell abstraction: bash on unix, PowerShell on Windows. Platform config dirs for daemon home. Distributed as per-OS single-file compiled binaries with one-line installers; CI build/smoke matrix across Linux/macOS/Windows.
10. **Frontend: Vite + React 19 SPA.** No meta-framework/SSR. TanStack Router, Convex React client, Tailwind + shadcn/ui, CodeMirror 6 for code and diff rendering (never Monaco), virtualized message lists. Deployed as a static bundle at a hosted domain.
11. **Multi-user auth from day one** (Convex Auth), with a machines table (owner, platform, heartbeat/online status, daemon version); projects and threads scope to a machine.
12. **Monorepo:** daemon app, web app, shared schema package (zod schemas for events, contracts, roles, policy shared by daemon/web/Convex), and the Convex functions directory.
13. **Core Convex tables:** projects, threads, messages, events, approvals, diffs, comments, roles, commands, auditLog, machines — subject to the pending Convex-components evaluation (see Further Notes).

## Testing Decisions

- A good test exercises external behavior at the highest seam and never asserts implementation details.
- **Primary seam — the Convex document boundary.** End-to-end tests drive the system exactly as real clients do: seed a git-repo fixture, insert documents (user message, approval resolution, one-off command), run the daemon against a test Convex deployment, then assert on resulting documents (messages, events, diffs, approvals, audit log) **and** on filesystem/git effects in the worktree. The daemon is a black box; the browser and the test driver are interchangeable clients.
- **Supporting seam — the ModelProvider interface.** The only fake: a scripted provider returning predetermined assistant turns and tool calls, making end-to-end runs deterministic and free. The interface exists anyway for provider-agnosticism, so it is not a test-only seam.
- Pure logic — policy evaluation, capability narrowing, stream batching, diff computation, contract parsing — gets ordinary unit tests below the seam (bun test/vitest).
- Latency budgets are tested: prompt-to-first-visible-token and command-output chunk latency against the batch-flush ceiling (≤ 200 ms).
- Prior art: greenfield repo, no existing tests. The Thanos test suite (vitest mirror of source) is the stylistic reference.

## Out of Scope

- **Live preview — permanently excluded** by explicit founder decision.
- Cloud sandbox execution (zero-install mode) — deferred to v2.
- Scheduled automations — deferred; Convex crons make later addition cheap, and the schema should not block it.
- Skills system, voice input, multi-repo/multi-root workspaces, mobile-optimized UI — deferred.
- Interactive PTY terminal — deferred; would require a second transport.
- Productization: pricing, billing, multi-tenant hardening beyond basic multi-user auth.

## Amendments (2026-07-09)

Every open decision from the wayfinder map is now resolved; the "unresolved" caveat from initial publication is void. The binding answers live on the tickets under `.scratch/relay-v1/issues/`; gists:

- **Convex components** — hand-rolled tables; borrow Agent-component schema shapes and persistent-text-streaming write patterns (batched, ordered, deduped, resumable); Workpool earmarked for v2 automations.
- **MCP** — target `2026-07-28` exclusively: stateless-first, streamable HTTP + stdio, Tasks extension yes, MCP Apps no, native-app OAuth with daemon-only token custody, bounded JSON Schema 2020-12 validation.
- **Event schema** — custom typed events, AG-UI-aligned naming where concepts overlap.
- **Sandboxing** — unix-first: landlock/bubblewrap + seatbelt confine exec to worktree+tmp, secrets denied; unsandboxed runs always require approval; Windows chokepoint-only until v1.x; Convex-relayed input is untrusted.
- **Context management** — summarization compaction 80%→~40% with pinned invariants; tool-result cap-and-spill to artifacts; append-only cache-breakpointed request contract.
- **Checkpoints** — per-mutating-turn commits under a hidden ref namespace; restore-not-destroy revert; GC with the thread.
- **Steering** — queue + turn-boundary inject + explicit Stop; approvals independent of the queue.
- **Usage** — per-LLM-call records with cache metrics, thread rollups incl. subagents, soft budgets.
- **Role roster** — nine seeded roles (explore, plan, researcher, oracle, reviewer, reviewer-security, evaluator, build, worker); designer deferred, scout and the two focused reviewers merged away.
- **Review mode** — jury (reviewer + reviewer-security, different models) → P0–P3 inline diff comments → "address findings" feeds the agent.

### Architecture reversal — adapter-first harness kernel (2026-07-15)

The v1 PRD's "Own agent loop" decision is **superseded** by three Architecture Decision Records that reverse the execution architecture:

- [ADR 0001: Adapter-First Local Harness](../../docs/adr/0001-adapter-first-local-harness.md) — the daemon no longer owns a raw agent loop. A deep `HarnessRuntime` interface hides orchestration and provider detail; Codex app-server is the first real adapter; `raw-llm` survives as a temporary migration adapter.
- [ADR 0002: Local Execution Authority with Convex Projections](../../docs/adr/0002-local-authority-convex-projections.md) — the daemon is the sole execution authority with a durable local SQLite store; Convex becomes the authenticated remote-command ingress and curated, resumable browser projection plane.
- [ADR 0003: Canonical Command and Event Model](../../docs/adr/0003-canonical-command-event-model.md) — an append-only canonical event log with a pure run-state reducer; the local store owns ordering, idempotency, and replay; provider-native shapes are normalized at the adapter seam.

A `RELAY_RUNTIME_MODE=legacy|shadow|kernel` flag gates the old path behind the new; all v1 Convex tables are widened additively, not dropped. The active self-hosted recovery and cutover detail lives in `docs/plans/2026-07-22-self-hosted-convex-recovery-implementation-plan.md`; the earlier harness-kernel plan remains historical implementation context.

## Further Notes
- Layout/UX north star: the Codex Desktop app (projects sidebar → threads, diff review with inline comments, approval flow). The governance/subagent mental model ports from Thanos (`~/.pi`): its glossary, ADRs, and role files are the design reference.
- Standing quality bar: extremely lightweight, fast, powerful. Every dependency and UI choice should be weighed against bundle size and latency; CodeMirror-over-Monaco is the canonical example of the standard to hold.
