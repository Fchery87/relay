# Relay

Relay is a browser control surface for a local coding-agent daemon. It pairs a locally running daemon with a Convex-backed workspace and renders its machine state in the web sidebar. The Convex backend is [self-hosted](docs/operations/self-hosted-convex.md) — a single local binary, no cloud account required.

## Architecture

Relay v1 uses a raw, daemon-owned agent loop. The **harness kernel** replaces this with a durable, adapter-first architecture. The kernel implementation has landed (provider runtime with registry/driver seams and a Codex app-server driver, orchestration task graph/scheduler/time machine and durable workflows, client-runtime sync/subscription supervisors, local task/artifact/history stores with retention, daemon extension and tool registries, observability, and conformance/crash/security gate scripts under `scripts/`); it runs behind `RELAY_RUNTIME_MODE` and stays off by default until the production acceptance gates pass.

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

0. **Backend**: start the self-hosted Convex backend if it isn't already running (`curl http://127.0.0.1:3210/version` to check): `~/.local/share/convex-selfhost/start-relay-backend.sh`. First-time machine setup (binary, keys, env files) is covered in [docs/operations/self-hosted-convex.md](docs/operations/self-hosted-convex.md).

   > **Two commands, two jobs** — the start script runs the backend *server* (the database itself; once per boot). `bun run convex:dev` (step 2) is the *deploy tool* that pushes the `convex/` code to that server. The server keeps serving whatever was last pushed, so step 2 is only needed when `convex/` code has changed — but the server must always be running first.

1. Install dependencies: `bun install`.
2. Push Convex functions to the deployment. This syncs schema validators and must run **before** the daemon (the daemon calls functions whose schemas may have changed locally). Skip it if `convex/` hasn't changed since the last push:

   ```bash
   bun run convex:dev
   ```

   Keep it running for live reload, or Ctrl+C once `🤖 Convex is ready` appears.

3. Start the web sidebar. If `apps/web/.env.local` does not already exist, create it and set `VITE_CONVEX_URL` to the backend URL (`http://127.0.0.1:3210` for the self-hosted backend):

   ```bash
   bun run web:dev
   ```

4. First-time pairing: generate a one-time code and enter it in the browser to link your machine:

   ```bash
   bun run daemon:connect
   ```

   The browser transitions automatically once the daemon registers (next step).

5. In another terminal, start the daemon. It reads the credentials saved by `connect` and registers your machine with the deployment:

   ```bash
   bun run daemon:dev
   ```

The sidebar marks a machine offline 30 seconds after its last heartbeat. Skip step 4 on subsequent runs — only the daemon (`daemon:dev`) and web sidebar (`web:dev`) need to stay running.

### Troubleshooting

**`ArgumentValidationError` or `Could not find public function for …`** — the deployed Convex functions are out of date with local code. Run `bun run convex:dev` to push the latest function schemas, tables, and validators, then retry.

**`fatal: Unable to create '…/.git/index.lock'` when committing** — the running daemon periodically executes git commands against the repo and can race your commit. Stop `daemon:dev`, remove the stale `.git/index.lock` if one is left behind, commit, then restart the daemon.

**`bun run` shows a help page instead of executing** — Bun's `--cwd` flag can misparse on some versions. The root `package.json` uses `cd <dir> && bun run <script>` to avoid this; if you encounter it in custom scripts, use the `cd` form instead.

**Browser stays on pairing screen after entering a valid code** — the daemon hasn't registered yet. `connect` only pairs; you must also start `bun run daemon:dev` in a separate terminal. Once the daemon registers, the browser transitions automatically.

## Production

The production distribution includes compiled Linux, macOS, and Windows daemon binaries, installers, release automation, and a Cloudflare Pages deployment workflow. Follow [the production deployment guide](docs/production-deployment.md) to configure Cloudflare and Convex credentials, create a release, install the daemon, pair it, and start it.

## Verification

```bash
bun run typecheck
bun run test
bun run build
```
