# Relay Manual

> The canonical repository entry point is [`MANUAL.md`](../MANUAL.md). This copy is
> retained beside the operations documentation for readers browsing `docs/`.

## Current self-hosted Convex status

Relay's self-hosted Convex workflow is currently supported for **local development with the legacy runtime**. The kernel runtime, schema narrowing, and production self-hosted deployment are not approved for general use yet.

Keep the daemon in legacy mode:

```bash
RELAY_RUNTIME_MODE=legacy bun run daemon:dev
```

If `RELAY_RUNTIME_MODE` is unset, legacy mode remains the default. Do not enable `shadow` or `kernel` for real work until the recovery plan's release gates pass.

## Start the local backend

The self-hosted backend is a separate process from the Convex deployment command. Start the backend once per boot:

```bash
curl -fsS http://127.0.0.1:3210/version
~/.local/share/convex-selfhost/start-relay-backend.sh
```

The documented local endpoints are:

- Convex API: `http://127.0.0.1:3210`
- Convex HTTP actions/site proxy: `http://127.0.0.1:3211`

The backend data and file storage live under:

```text
~/.local/share/convex-selfhost/relay-data/
```

Do not delete this directory during troubleshooting. Back it up before backend upgrades, migrations, or recovery work.

## Deploy Convex functions

After the backend is healthy, deploy the current `convex/` functions separately:

```bash
bunx convex dev --once
```

This command deploys the application functions and schema; it does not start the backend server. Run it again when `convex/` code changes.

## Start Relay development processes

Use separate terminals for the web app and daemon:

```bash
bun run web:dev
bun run daemon:dev
```

The web app uses `apps/web/.env.local` and `VITE_CONVEX_URL`. The daemon uses `apps/daemon/.env.local` and `RELAY_CONVEX_URL`. These URLs must target the same deployment.

The daemon stores paired deployment credentials in its daemon-home credential store. Changing `RELAY_CONVEX_URL` does not necessarily retarget an already paired daemon; re-pair it when moving to a different deployment.

## Safe troubleshooting order

When the daemon reports errors or appears offline, check in this order:

1. **Backend process:**
   ```bash
   curl -fsS http://127.0.0.1:3210/version
   ```
2. **Function deployment:**
   ```bash
   bunx convex dev --once
   ```
3. **Environment alignment:** verify the web and daemon URLs point to the same backend without printing secret values.
4. **Daemon credentials:** confirm the daemon is paired with the intended deployment; re-pair after changing deployments.
5. **Daemon mode:** confirm that `RELAY_RUNTIME_MODE` is unset or explicitly `legacy`.
6. **Backend logs:** inspect the backend log for `UserTimeout`, OCC failures, missing public functions, validation errors, and authentication failures.
7. **Restart order:** stop the daemon, verify the backend is still healthy, redeploy functions if needed, then start the daemon again.

Do not “fix” a timeout by enabling kernel mode or narrowing schemas. Those are migration actions, not daemon troubleshooting steps.

## Recovery-plan gates

Before enabling kernel mode, browser projection reads, or schema narrowing, complete the [Self-Hosted Convex Recovery and Kernel Cutover Implementation Plan](plans/2026-07-22-self-hosted-convex-recovery-implementation-plan.md). In particular, the plan requires:

- one canonical command and run-identity contract;
- durable effect/reactor ownership instead of direct provider execution in `KernelDaemon`;
- ordered projection outbox publication and cursor verification;
- independent machine heartbeat and bounded claim mutations;
- sandbox, filesystem, pairing, role, and operator-function security fixes;
- pinned backend version plus backup/restore rehearsal;
- an explicit hosted-history decision;
- live self-hosted integration tests and crash/restart tests;
- browser cutover and canary evidence;
- one complete kernel-default release window before legacy removal;
- schema narrowing only in a later release with rollback evidence.

## Verification commands

Run the focused checks before reporting the local environment healthy:

```bash
bun run typecheck
bun run test
bun run conformance:matrix
bun run build
bun run bundle:check
bun run security:gate
```

A passing in-process Convex suite alone does not prove the self-hosted backend is healthy. The live backend must answer `/version`, the current functions must deploy successfully, and the daemon must maintain heartbeat and claim health during a sustained run.

## Related documentation

- [Self-hosted Convex operations](operations/self-hosted-convex.md)
- [Recovery and kernel cutover implementation plan](plans/2026-07-22-self-hosted-convex-recovery-implementation-plan.md)
- [Production readiness checklist](operations/production-readiness-checklist.md)
- [Incident runbook](operations/incident-runbook.md)
- [Support matrix](operations/support-matrix.md)
