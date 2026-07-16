# Relay

Relay is a browser control surface for a local coding-agent daemon. It pairs a locally running daemon with the Convex-backed workspace and renders its machine state in the web sidebar.

## Architecture

Relay v1 uses a raw, daemon-owned agent loop. The **harness kernel** (in progress) replaces this with a durable, adapter-first architecture:

- **`@relay/contracts`** — canonical types: branded identifiers, event/command envelopes, run state machine, history, workspace, permissions
- **`@relay/harness-runtime`** — deep `HarnessRuntime` interface (single primary seam), deterministic fake, local durable implementation, context manager
- **`@relay/orchestration`** — pure decider, serialized orchestration engine, history projection, shadow runner, workflow abstraction
- **`@relay/local-store`** — WAL-backed SQLite store: events, snapshots, command receipts, projection outbox, provider sessions, workspaces, checkpoints, leases
- **`@relay/workspace-runtime`** — workspace manager (durable records, reconcile), checkpoint manager (idempotent capture, restore-not-destroy), sandbox executor (bubblewrap/Seatbelt/Windows fail-closed)
- **`@relay/client-runtime`** — snapshot+sequence client state, cursor-based resume, ordered delta application
- **`@relay/provider-runtime`** — provider driver/instance/session adapter seams
- **`@relay/providers/codex-app-server`** — Codex app-server provider adapter (normalization layer)
- **`@relay/shared`** — legacy/shared utilities (models, tools, subagents, policies)

**Runtime modes:** `RELAY_RUNTIME_MODE=legacy|shadow|kernel` (default `legacy` until production acceptance gates pass). See [the kernel spec](.scratch/harness-kernel/PRD.md) and [ticket breakdown](tickets.md).

**Architecture Decision Records:** [docs/adr/](docs/adr/)

## Development

1. Install dependencies: `bun install`.
2. Create or connect a Convex development deployment: `bun run convex:dev`.
3. In `apps/web/.env.local`, set `VITE_CONVEX_URL` to that deployment's URL and start the SPA: `bun run web:dev`.
4. In another terminal, run the daemon with a development token and the projects it should register:

```bash
RELAY_CONVEX_URL=https://your-deployment.convex.cloud \
RELAY_DEVICE_TOKEN=replace-with-a-development-token \
RELAY_PROJECTS='[{"name":"relay","path":"/absolute/path/to/relay"}]' \
bun run daemon:dev
```

The sidebar marks a machine offline 30 seconds after its last heartbeat.

## Production

The production distribution includes compiled Linux, macOS, and Windows daemon binaries, installers, release automation, and a Cloudflare Pages deployment workflow. Follow [the production deployment guide](docs/production-deployment.md) to configure Cloudflare and Convex credentials, create a release, install the daemon, pair it, and start it.

## Verification

```bash
bun run typecheck
bun run test
bun run build
```
