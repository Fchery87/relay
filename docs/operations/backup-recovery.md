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

### Manual follow-up (not yet automated as a single script)

The restore script prints these as next steps. A full run was rehearsed live
on 2026-07-22 and again on 2026-07-23 against this repo's own dev instance:

1. **Start a backend against the restored SQLite file** on a different port
   than the live instance, using the instance name from the manifest.
   **Verified live**: the staging backend started and served the restored
   data; the restored admin key authenticated successfully.
2. **Deploy schema/functions** against the staging instance.
   **Verified live** — with a real finding: the first deploy attempt failed
   schema validation, because two pre-existing `pairings` documents
   (created before `deviceNonce` became a required field, both already
   `claimed` and expired 2026-07-20) don't match the current schema. This
   is not a restore bug — the same two documents were confirmed present on
   the **live** backend too (read-only check, not modified). It means the
   **next real `bun run convex:dev` / `npx convex deploy` against the live
   backend will fail the same way** until those rows are cleaned up.
   Cleared on the disposable staging copy only (`npx convex import --table
   pairings --replace` with an empty file) to continue the rehearsal;
   the live database was left untouched pending an explicit decision to
   clean it up.
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

### Residual, not yet automated

- Password sign-in itself (not just account presence) is unverified against
  restored data.
- No single script runs steps 1–7 end to end; each step above was run by
  hand. A `restore-acceptance.ts` harness automating this (matching the
  pattern of `scripts/soak-legacy-claims.ts`) is still open work.
- The stale-`pairings`-document finding above is a real, live issue
  independent of backup/restore — see the note in
  [self-hosted-convex.md](self-hosted-convex.md) — and should be resolved
  before the next real schema push to the live backend.

## What "release evidence" means here

Before any schema narrowing or legacy-execution removal (see `tickets.md`,
"Back up and restore the complete execution system" and later), record a
fresh backup/restore/verify cycle's output (script stdout, manifest,
`bun run scripts/verify-self-hosted-convex.ts` result) as that release's
evidence. No format is mandated yet beyond "keep the actual command output" —
a dedicated machine-readable evidence schema is still open work (see
`tickets.md`, "Pin and supervise the self-hosted topology").
