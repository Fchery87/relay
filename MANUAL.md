# Relay Manual

This manual is the operator-facing entry point for running Relay with the local self-hosted Convex backend.

## Support status

Self-hosted Convex is currently supported for local development with the **legacy** Relay runtime. Keep `RELAY_RUNTIME_MODE=legacy` or leave it unset. Kernel mode, schema narrowing, and production self-hosted deployment are not approved until the recovery plan gates pass.

See:

- [Self-hosted Convex operations](docs/operations/self-hosted-convex.md)
- [Self-Hosted Convex Recovery and Kernel Cutover Implementation Plan](docs/plans/2026-07-22-self-hosted-convex-recovery-implementation-plan.md)

## Start the backend

Check the backend health endpoint:

```bash
curl -fsS http://127.0.0.1:3210/version
```

If it is not running, start it with:

```bash
~/.local/share/convex-selfhost/start-relay-backend.sh
```

The local endpoints are:

- API: `http://127.0.0.1:3210`
- HTTP actions/site proxy: `http://127.0.0.1:3211`

The backend database and file storage are under `~/.local/share/convex-selfhost/relay-data/`. Do not delete that directory during troubleshooting. Back it up before upgrades, migration work, or recovery.

## Deploy Convex functions

The backend process and Convex deployment command are separate:

```bash
bunx convex dev --once
```

This deploys the current `convex/` functions and schema to the configured self-hosted backend. It does not start the backend server.

## Start Relay

Use separate terminals:

```bash
bun run web:dev
bun run daemon:dev
```

The web app reads `VITE_CONVEX_URL` from `apps/web/.env.local`. The daemon reads `RELAY_CONVEX_URL` from `apps/daemon/.env.local`. Both must point to the same Convex deployment.

The daemon prefers its persisted pairing credentials. If the deployment URL changes, re-pair the daemon instead of assuming an environment-file change retargets it.

## Troubleshooting order

1. Check `http://127.0.0.1:3210/version`.
2. Run `bunx convex dev --once` to deploy current functions.
3. Confirm web and daemon URLs match without printing secrets.
4. Confirm the daemon is paired to the intended deployment.
5. Confirm `RELAY_RUNTIME_MODE` is unset or `legacy`.
6. Inspect backend logs for `UserTimeout`, OCC failures, missing public functions, validation errors, or auth failures.
7. Restart the daemon only after the backend is healthy and functions are deployed.

Do not enable kernel mode, run schema narrowing, or delete legacy data as a troubleshooting step. Those require the recovery plan's migration, backup, security, live-backend, canary, and rollback gates.

## Verification

Run the relevant checks before declaring the local environment healthy:

```bash
bun run typecheck
bun run test
bun run conformance:matrix
bun run build
bun run bundle:check
bun run security:gate
```

The in-process Convex suite is not sufficient by itself. A healthy self-hosted setup must also answer `/version`, accept `bunx convex dev --once`, and keep daemon heartbeat and claim operations healthy during a sustained run.
