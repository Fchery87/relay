# Relay — Browser-Based Agentic Coding Platform

## Context

Build a browser-based agentic coding platform in this repo (`relay`), modeled on the Codex Desktop app's layout and top features (projects → parallel threads, worktree isolation, diff review with inline comments, plan mode) but delivered as a web UI instead of an Electron app. **No live preview feature — ever.** The subagent system, governance harness, and workflow port from the user's existing Thanos setup at `~/.pi` (a governance extension over the Pi coding agent). Priorities: extremely lightweight, fast, and powerful.

All architectural decisions below were grilled and approved one-by-one by the user.

## Approved architecture decisions

1. **Execution: local host daemon.** A daemon on the user's machine owns the filesystem, shell, git, and agent loop. The browser never executes anything.
2. **Agent core: own loop.** The daemon implements its own agent loop (provider-agnostic LLM calls, tool execution, context management) — not a wrapper around Pi/Codex CLI.
3. **Convex is the backbone.** Daemon ⇄ Convex ⇄ browser. All thread state, messages, events, approvals flow through Convex reactive queries. Daemon opens no ports (access-from-anywhere works behind NAT). Token streams are **batched (~100–200 ms flushes)** into Convex, not per-token mutations.
4. **v1 scope:** projects sidebar → parallel threads; each thread on a disposable detached-HEAD git worktree; streaming agent loop; diff review with **inline comments that feed back to the agent**; stage/commit/push from UI; plan mode (plan model ≠ build model); subagent roster; browser approval cards; per-role model routing; MCP support; command-stream terminal. **Deferred:** scheduled automations, cloud sandboxes, skills, voice, multi-repo. **Excluded permanently:** live preview.
5. **Terminal = command stream**, not interactive PTY. Agent-run commands stream output live; user can send one-off commands to the thread's worktree. Single Convex transport.
6. **Subagents: port Thanos roster.** Declarative role definitions (name, description, tools, model, thinking, maxTurns, context `fresh|forked`, read-only vs writer) stored in Convex, editable in UI. Writers get nested worktrees; readers run fresh-context. Typed Subagent Result Contracts; depth cap 2.
7. **Governance: port the before-tool chokepoint.** Capability (`read|edit|exec|task`) × risk tier (`low|high|critical`) × policy rules → allow/deny/ask; "ask" renders as an approval card in the browser. Per-subagent capability narrowing (each hop only narrows). Audit log to Convex.
8. **Models: port `models.json` approach.** Provider-agnostic catalog (theclawbay, theclawbay-claude, zai, direct anthropic/openai), thinking-level maps, per-role routing with fallbacks, cheap-recon/expensive-judgment tiering. **API keys live only in the daemon** (local secrets file) — never in Convex or the browser.
9. **Daemon: Bun + TypeScript.** Git via the `git` CLI. Single-file executable via `bun build --compile` eventually.
10. **Frontend: Vite + React 19 SPA** (no meta-framework/SSR). TanStack Router, Convex React client, Tailwind + shadcn/ui, **CodeMirror 6** for code/diff rendering (never Monaco), virtualized message lists.

## Reference material (read before implementing each area)

- `~/.pi/CONTEXT.md` — ubiquitous-language glossary; the authors' mental model.
- `~/.pi/docs/adr/*` — 0001 subprocess subagents, 0004 opt-in forked context, 0005 background results via polling, 0006 verification gate, 0007 goal-loop single driver.
- `~/.pi/agent/agents/*.md` — the 13 role definitions to port (explore, scout, plan, researcher, oracle, reviewer×3, evaluator, build, worker, designer).
- `~/.pi/src/hooks/before-tool.ts` — the governance chokepoint to port.
- `~/.pi/src/agents/{task-tool,policy,model-routing,loader}.ts` — spawn mechanics, capability narrowing, routing.
- `~/.pi/agent/{models.json,settings.json}` — provider catalog shape and per-role overrides.
- Codex app docs (layout/UX reference): developers.openai.com/codex/app — threads, worktrees, diff review, handoff.

## Repo structure (monorepo)

```
relay/
├── apps/
│   ├── daemon/        # Bun + TS: agent loop, tools, git, worktrees, governance
│   └── web/           # Vite + React 19 SPA
├── packages/
│   └── shared/        # zod schemas: events, contracts, roles, policy — shared by daemon/web/convex
├── convex/            # Convex functions + schema (state backbone)
└── docs/              # existing agent-skills config; add ADRs as decisions land
```

## Convex data model (core tables)

- `projects` — path, name, defaultBranch, delivery mode.
- `threads` — projectId, title, status (`idle|running|awaiting_approval|done|failed`), worktree info, model config, parent thread (for subagents), role.
- `messages` — threadId, role, parts (text/tool-call/tool-result), streaming flag. Streamed text updated by batched patch mutations.
- `events` — threadId, typed harness events (tool start/end, command output chunks, worktree ops) for the activity/terminal views.
- `approvals` — threadId, tool call descriptor, risk tier, status (`pending|approved|denied`), resolution source.
- `diffs`/`comments` — per-thread diff snapshots + inline review comments (file, line range, body, resolved) that feed back into the agent's next turn.
- `roles` — subagent role definitions (the Thanos frontmatter fields).
- `commands` — one-off user commands to run in a worktree; daemon subscribes and executes.
- `auditLog` — governance decisions.
- `machines` — userId, name, platform, status online/offline via heartbeat, daemon version. `projects`/`threads` scope to a machine.

Daemon connectivity: daemon authenticates to Convex with a device token, **subscribes** to work queues (new user messages, approval resolutions, one-off commands) and **writes** batched events/messages. Convex is the only transport.

## Distribution, onboarding & cross-platform (production posture)

**How a user runs Relay:** the web UI is a hosted SPA at a domain (static CDN deploy) backed by a production Convex deployment — but agents execute on a machine the user connects. The browser alone cannot touch files/shells (browser sandbox), which is why the daemon exists.

Onboarding flow:
1. Visit the site, sign in (Convex Auth; multi-user from day one so production isn't a retrofit).
2. "Connect a machine": one-line installer — `curl | sh` (Linux/macOS) or PowerShell `irm | iex` (Windows) — installs a single compiled binary (`bun build --compile`, per-OS targets, CI-built for linux-x64/arm64, darwin-x64/arm64, windows-x64).
3. `relay connect` → browser pairing-code flow → daemon stores a device token, registers in a `machines` table in Convex.
4. All of that user's machines + projects appear in any browser they sign into. Daemon opens no inbound ports; outbound-only to Convex.

Cross-platform requirements for the daemon (Linux/Windows/macOS):
- Shell abstraction: `bash -lc` on unix, PowerShell on Windows; never hardcode `/bin/sh`.
- Path handling via `node:path` everywhere; no assumptions about `~`; daemon home = platform config dir (`~/.relay` / `%APPDATA%\relay`).
- No `node-pty` (avoided by command-stream decision — the main Windows native-module pain).
- `git` on PATH is a checked prerequisite with a clear error; worktrees behave identically on all three OSes.
- CI matrix builds + smoke-tests the daemon on all three platforms.

## Build phases

**Phase 1 — Skeleton + vertical slice.** Monorepo scaffold (bun workspaces), Convex schema, daemon that connects to Convex and runs a minimal agent loop (one provider, read/edit/bash tools, no governance), web app with project/thread sidebar + streaming chat view. Milestone: type a prompt in the browser, watch an agent edit a file on disk.

**Phase 2 — Worktrees + git.** Disposable detached-HEAD worktrees per thread (Codex-managed style, created under a daemon home dir, GC'd); diff computation + snapshot to Convex; diff viewer (CodeMirror 6 merge view); stage/commit/push from UI.

**Phase 3 — Governance.** Port before-tool chokepoint, policy file, risk tiers, approval cards in browser, audit log. Keys/secrets handling in daemon.

**Phase 4 — Model catalog + routing.** Port models.json shape, provider adapters (anthropic-messages, openai-responses/completions), thinking levels, per-role routing with fallbacks, model picker UI.

**Phase 5 — Subagents.** Role loader (Convex-stored roles seeded from ported Thanos roles), nested loops with capability narrowing, writer worktree isolation, result contracts, subagent tree view in thread UI.

**Phase 6 — Production distribution.** Auth + machine pairing flow (`relay connect`, device tokens, `machines` table, heartbeat/online status); per-OS compiled binaries + install scripts; CI build/smoke matrix (linux/mac/windows); hosted SPA deploy + Convex prod deployment.

**Phase 7 — Review + plan mode + polish.** Inline diff comments → agent turn; plan mode (separate plan/build models, plan artifact view); command-stream terminal panel; MCP client support; performance pass (virtualization, bundle budget).

## Verification

- Each phase ends with a driven end-to-end check from the browser: e.g. Phase 1 = prompt → file edited on disk with streamed output visible; Phase 2 = two threads editing the same repo concurrently without conflict, diff reviewed and committed from UI; Phase 3 = a `rm -rf` class command produces an approval card and a deny actually blocks it (audit entry present).
- Unit tests (vitest/bun test) for: policy evaluation, capability narrowing, diff computation, contract parsing, stream batching.
- Latency budget checks: prompt-to-first-token visible in browser, and command output chunk latency, measured against the "fast" requirement (batch flush ≤ 200 ms).
