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

### Manual follow-up (not yet automated)

The restore script prints these as next steps; they are not yet exercised by
an automated staging-acceptance test:

1. Start a backend against the restored SQLite file on a **different port**
   than the live instance, using the **same `--instance-name`** as the
   original (the admin key is cryptographically bound to
   `instance-name` + `instance-secret` together — renaming the instance
   invalidates the restored admin key even though the secret matches).
2. Deploy schema/functions (`npx convex deploy`) against the staging
   instance and confirm sign-in, pairing, and project/thread reads work.
3. Point a daemon at the restored daemon-home directory and confirm it
   reconnects and reopens `relay-kernel.sqlite` cleanly.
4. Confirm no secret from the restore appears in any log or diagnostic
   export produced during the above steps.
5. Tear down the staging backend and delete the staging directory —
   it holds a live copy of production-equivalent credentials.

This was verified manually on 2026-07-22: a real backup/restore cycle against
this repo's own dev instance produced a staging backend that accepted the
restored admin key and served the restored data (function deployment is the
separate, expected next step — the restored instance has no functions
pushed to it yet, by design, since function code is redeployed rather than
included in the data backup).

## What "release evidence" means here

Before any schema narrowing or legacy-execution removal (see `tickets.md`,
"Back up and restore the complete execution system" and later), record a
fresh backup/restore/verify cycle's output (script stdout, manifest,
`bun run scripts/verify-self-hosted-convex.ts` result) as that release's
evidence. No format is mandated yet beyond "keep the actual command output" —
a dedicated machine-readable evidence schema is still open work (see
`tickets.md`, "Pin and supervise the self-hosted topology").
