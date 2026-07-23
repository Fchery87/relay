# Backup and recovery — self-hosted Convex + daemon

Covers what's backed up, how to restore into isolated staging, and what's
verified automatically versus manually today. See
[self-hosted-convex.md](self-hosted-convex.md) for day-to-day operation and
[self-hosted-convex-pin.json](self-hosted-convex-pin.json) for the pinned
backend checksum.

## What a backup includes

`scripts/backup-self-hosted-convex.sh` copies, into one timestamped,
checksummed, `chmod 700` directory:

- **Convex data root** — `convex_local_backend.sqlite3`, taken with `sqlite3
  .backup` (an online-safe snapshot; safe even while the backend is running
  and writing).
- **Convex file storage** — the `convex_local_storage/` tree.
- **Required credentials** — `instance-secret.txt`, `admin-key.txt`,
  `jwt-private-key.txt`, `jwks.txt`. Omit with `--no-secrets` if you only
  want data (that backup alone cannot restore a working, authenticatable
  instance).
- **Daemon-local state** — `device.json`, `projects.json`, `worktrees.json`,
  and `relay-kernel.sqlite` (kernel mode), also via `sqlite3 .backup` when
  present.
- **`manifest.json`** — sha256 of every file plus creation time, for
  integrity verification at restore time.

```bash
scripts/backup-self-hosted-convex.sh --out ./relay-backups/2026-07-22
```

Treat a backup directory as being as sensitive as the live instance — it
contains the admin key and device credentials.

## Restoring into isolated staging

`scripts/restore-self-hosted-convex.sh` verifies every checksum in
`manifest.json`, refuses to write into `~/.local/share/convex-selfhost` or
`~/.config/relay` (or their `RELAY_CONVEX_SELFHOST_HOME` /
`RELAY_DAEMON_HOME` overrides) so a restore can never clobber a live
instance, and then copies the backup into the staging directory you name:

```bash
scripts/restore-self-hosted-convex.sh --backup ./relay-backups/2026-07-22 --staging /tmp/relay-staging
```

Use `--verify-only` to check integrity without copying anything.

### Automated today

- Checksum verification of every backed-up file.
- Refusal to restore over a live convex-selfhost or daemon home.
- The restore script's printed instructions use the real, backed-up
  `--instance-name` (recorded in `manifest.json`) — an earlier draft of
  this script printed a renamed instance name in its example command, which
  would have produced an admin key that fails to authenticate (the admin
  key is cryptographically bound to `instance-name` + `instance-secret`
  together). Caught and fixed via a real restore rehearsal, not by
  inspection.

### Functional acceptance

The restore script prints these as next steps. A full run was rehearsed live
on 2026-07-22 and again on 2026-07-23 against this repo's own dev instance:

1. **Start a backend against the restored SQLite file** on a different port
   than the live instance, using the instance name from the manifest.
   **Verified live**: the staging backend started and served the restored
   data; the restored admin key authenticated successfully.
2. **Deploy schema/functions** against the staging instance.
   **Verified live** — the first rehearsal surfaced two pre-existing
   `pairings` documents (created before `deviceNonce` became a required field,
   both already `claimed` and expired 2026-07-20). The compatibility schema
   now accepts those historical rows without weakening new registration:
   missing-nonce claimed/expired records are unusable, and the internal
   `migrations:cleanupLegacyPairings` mutation removes them in bounded batches
   after the deploy. The live backend was not modified during the original
   read-only investigation; run the compatibility deploy, then the cleanup
   mutation when the operator is ready.
3. **Confirm sign-in, pairing, and project/thread reads work.**
   **Verified live**: after the schema deploy, the restored `users`,
   `machines`, and `projects` tables held the real accounts, the real
   paired machine (`nochaserz-MacBookPro`), and the real project
   (`relay` at its real repo path) with correct ownership relationships
   (`machine.ownerId` → `users`, `project.machineId` → `machines`) intact.
   Sign-in itself (password verification) was not exercised — this repo
   doesn't have a spare set of test credentials to log in with — but the
   auth infrastructure and account records are confirmed present and
   correctly linked.
4. **Point a daemon at the restored daemon-home and confirm it reconnects.**
   **Verified live, directly**: called `machines:heartbeat` against the
   restored staging backend using the *real* device token from this
   machine's `~/.config/relay/device.json`. It authenticated against the
   restored machine record and updated `lastHeartbeatAt`, proving both the
   read (device-token-hash lookup) and write path work against restored
   data. `relay-kernel.sqlite` reopening was not exercised in this specific
   rehearsal — no kernel-mode local store exists yet in this dev
   environment — but the same open/close-and-reopen-from-file mechanism is
   covered by `packages/harness-runtime/src/local-harness-runtime.integration.test.ts`
   and `apps/daemon/src/kernel-daemon.projection-outbox.test.ts`'s
   "daemon restart" case.
5. **Projection reconciliation.** The restored `projectionEvents`,
   `projectionSnapshots`, `projectionCursors`, and `commandInbox` tables
   were empty in this dev instance (kernel mode hasn't produced real
   projection data here yet), so there was nothing to reconcile in this
   specific rehearsal. Gap/backlog detection logic itself is covered by
   `apps/daemon/src/kernel-daemon.projection-outbox.test.ts` and the
   Convex-side `projections/publish:projectionMetrics` query.
6. **Confirm no secret appears in logs/exports produced during the above.**
   Reviewed the CLI output from every command run during this rehearsal —
   none echoed `instance-secret.txt`/`admin-key.txt`/device-token values.
7. **Tear down and delete the staging directory.** Done both times.

The repeatable acceptance harness runs the isolated backend and schema deploy,
then verifies restored password sign-in, owner-scoped machine/project reads,
fresh pairing, machine registration and heartbeat, thread create/read, and the
projection metrics query. It never uses the live backend, requires credentials
only through environment variables, and removes its staging directory on exit
unless `--keep-staging` is supplied:

```bash
RELAY_RESTORE_ACCEPTANCE_EMAIL=user@example.com \
RELAY_RESTORE_ACCEPTANCE_PASSWORD='...' \
bun run convex:restore:acceptance -- --backup ./relay-backups/2026-07-22
```

This path passed on 2026-07-23 against a disposable backup containing a real
isolated backend database and module-storage tree. The generated account,
machine, project, and thread were temporary, and the backup, staging directory,
and backend were deleted after the run.

The restored Convex instance secret is still passed to the backend process using
the upstream-required `--instance-secret` argument; this accepted process-list
risk is documented in [self-hosted-convex.md](self-hosted-convex.md). The
restore account's email and password are environment-only.

Use `--backend-bin PATH` when the backend is not at the documented default,
or `RELAY_CONVEX_BACKEND_BIN`. Use `--staging DIR --keep-staging` when keeping
the restored files for inspection. The staging copy contains live credentials;
delete it after inspection.

### Residual release evidence

- The harness does not manufacture kernel-mode command/projection history. A
  backup containing real `relay-kernel.sqlite` and projection data still needs
  a release-window rehearsal that reopens the local store and confirms
  reconciliation/backlog behavior against that data.
- The compatibility deploy and bounded cleanup mutation still need to be
  applied to the live backend and recorded as release evidence; the deploy is
  no longer blocked by historical missing-nonce rows.

## What "release evidence" means here

Before any schema narrowing or legacy-execution removal (see `tickets.md`,
"Back up and restore the complete execution system" and later), record a
fresh backup/restore/verify cycle's output (script stdout, manifest,
`bun run scripts/verify-self-hosted-convex.ts` result) as that release's
evidence. The machine-readable container is produced by
`bun run release:evidence -- --input <facts.json> --output <record.json>` and is
documented in [release-evidence/schema.md](release-evidence/schema.md). It
records the source artifact IDs, command/test IDs, versions, topology,
redacted diagnostics, and every cutover gate. It writes mode `0600` and exits
with status `78` when facts are incomplete, diagnostics contain failures, or
any gate is false. The container does not turn local or deterministic output
into hosted/provider/release evidence; operators must supply those real facts
in the input document.

The record also carries the reviewed backup/rollback `rehearsalHash`. After
review, persist its validated gates server-side with
`bun run release:evidence:record -- --input <record.json>` while supplying
`CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` through the
environment. The recorder refuses blocked evidence before making the internal
Convex mutation.

The Convex-side narrowing guard independently requires the reviewed proof to
be recorded server-side. `convex/narrow.ts` is internal-only and rejects a
caller-supplied rehearsal hash unless it matches the active `releaseEvidence`
record and every release gate is true. The current live contraction branch is
intentionally disabled; do not treat a successful dry run as schema removal.
