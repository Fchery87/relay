# Self-hosted Convex backend

> [!CAUTION]
> The current self-hosted deployment is supported for the legacy local-development
> runtime only. Kernel cutover, schema narrowing, and production self-hosting are
> **not approved** yet. The ordered remediation work and release gates are tracked
> in the [Self-Hosted Convex Recovery and Kernel Cutover Implementation Plan](../plans/2026-07-22-self-hosted-convex-recovery-implementation-plan.md).
>
> Keep `RELAY_RUNTIME_MODE=legacy`. Do not run `narrow:narrowProjections` or delete
> legacy data until that plan's migration, backup/restore, security, live-backend,
> canary, and release-window gates have all passed. For the full operator workflow,
> see the [Relay Manual](../../MANUAL.md).

Relay's local-development backend runs on a **self-hosted Convex instance** — the
same open-source code Convex cloud runs, as a single prebuilt binary with SQLite
storage. No Docker or cloud account is required for this local topology. The
instance serves the web app, daemon, and Convex CLI; the `convex/` application
code is shared with a hosted deployment.

- Backend API (`CONVEX_URL`): `http://127.0.0.1:3210`
- HTTP actions (`CONVEX_SITE_URL`): `http://127.0.0.1:3211`
- Install root: `~/.local/share/convex-selfhost/`
- Data: SQLite + file storage under `~/.local/share/convex-selfhost/relay-data/`
  (back this directory up; it is the entire database). Use
  `scripts/backup-self-hosted-convex.sh` — see
  [backup-recovery.md](backup-recovery.md) — rather than an ad hoc copy; the
  SQLite files are backed up online-safely and daemon-local state is
  included too.

## One-time setup on a new machine

### 1. Download the binary

Do not install from a floating `latest` URL without recording what you got.
Download a **specific release tag**, verify it, and pin it:

```bash
mkdir -p ~/.local/share/convex-selfhost/relay-data
cd ~/.local/share/convex-selfhost
curl -sLO https://github.com/get-convex/convex-backend/releases/download/<TAG>/convex-local-backend-x86_64-unknown-linux-gnu.zip
sha256sum convex-local-backend-x86_64-unknown-linux-gnu.zip  # record this before unzipping
unzip convex-local-backend-x86_64-unknown-linux-gnu.zip && chmod +x convex-local-backend
sha256sum convex-local-backend
```

Record both checksums, the release tag, and the date in
[`self-hosted-convex-pin.json`](self-hosted-convex-pin.json) (update
`binarySha256`, `releaseArchiveSha256`, and `pinnedAt` together). The binary
has no embedded semver — `convex-local-backend --version` reports
`local_backend unknown` — so the checksum pin is the only reliable version
identity. Verify an install (or after every upgrade) with:

```bash
bun run convex:verify
```

which checks the running backend's `/version` responds *and* the installed
binary's checksum matches the pin — refusing to treat an unvetted binary as
trustworthy just because a backend answered on port 3210.

### 2. Generate instance credentials

```bash
cd ~/.local/share/convex-selfhost
openssl rand -hex 32 > instance-secret.txt
./convex-local-backend keygen admin-key \
  --instance-name convex-self-hosted \
  --instance-secret "$(cat instance-secret.txt)" > admin-key.txt
chmod 600 instance-secret.txt admin-key.txt
```

### 3. Create the start script

Save as `~/.local/share/convex-selfhost/start-relay-backend.sh` (`chmod +x`):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/relay-data"
exec ../convex-local-backend \
  --instance-name convex-self-hosted \
  --instance-secret "$(cat ../instance-secret.txt)" \
  --interface 127.0.0.1 \
  --port 3210 \
  --site-proxy-port 3211
```

### 4. Start the backend

The backend is started manually — run this after each reboot (or whenever it
isn't running) before using the CLI, daemon, or web app:

```bash
~/.local/share/convex-selfhost/start-relay-backend.sh
```

Run it in its own terminal (Ctrl+C stops it), or detached in the background:

```bash
setsid nohup ~/.local/share/convex-selfhost/start-relay-backend.sh \
  >> ~/.local/share/convex-selfhost/backend.log 2>&1 < /dev/null &
```

Health check: `curl http://127.0.0.1:3210/version` should respond (or run
`bun run convex:verify`, which also checks the binary checksum). Stop a
detached backend with `pkill -f convex-local-backend`; data persists across
restarts.

> [!WARNING]
> `convex-local-backend --instance-secret` has no environment-variable
> alternative in the current upstream CLI (unlike `--disable-beacon`, which
> does). The secret is therefore visible in this process's argv to any other
> process running as the same local user (e.g. via `ps` or
> `/proc/<pid>/cmdline`) for the life of the backend. This is a known,
> accepted limitation for a single-user local-dev machine, not something
> this repo's scripts can fully close today — do not run this topology on a
> shared or multi-tenant host. `instance-secret.txt` and `admin-key.txt`
> stay `chmod 600` regardless.
>
> **Considered and rejected:** wrapping the backend in a PID/mount namespace
> (`unshare --pid --mount-proc`, or bubblewrap) does *not* hide its argv —
> Linux exposes a nested-namespace process's real PID and
> `/proc/<realpid>/cmdline` in the parent (root) namespace too, so another
> process running as the same local user can still read it directly
> regardless of namespacing. That technique isolates what the *child* can
> see, not what others can see *of* the child. The only real mitigation for
> a genuinely multi-user host is a system-wide `hidepid=2` mount option on
> `/proc` (hides other users' `/proc/<pid>` entries entirely) — that's an
> operator decision affecting every process on the machine, not something
> this repo's scripts apply on your behalf.

> Optional: to start it automatically at boot instead, wrap the script in a
> systemd user service (`ExecStart=%h/.local/share/convex-selfhost/start-relay-backend.sh`,
> `WantedBy=default.target`), then `systemctl --user enable --now` it and run
> `loginctl enable-linger "$USER"`. This repo's setup uses manual start.

### 5. Point the repo at the local backend

The Convex CLI reads the root `.env.local`; the apps read their own:

```bash
# .env.local (repo root — used by npx convex deploy/dev/env/run)
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
CONVEX_SELF_HOSTED_ADMIN_KEY=<contents of admin-key.txt>
CONVEX_URL=http://127.0.0.1:3210
CONVEX_SITE_URL=http://127.0.0.1:3211

# apps/web/.env.local
VITE_CONVEX_URL=http://127.0.0.1:3210

# apps/daemon/.env.local
RELAY_CONVEX_URL=http://127.0.0.1:3210
```

`CONVEX_DEPLOYMENT` must **not** be set — it targets cloud deployments and the
CLI refuses to mix it with the self-hosted variables.

### 6. Deploy functions and set auth keys

```bash
bun run convex:dev          # or: npx convex deploy --yes
```

Convex Auth (password sign-in) needs an RS256 keypair on the deployment.
Generate one (Node's WebCrypto is enough — export the private key as PKCS#8
PEM and the public key as a JWKS with `use: "sig"`, `alg: "RS256"`), then:

```bash
npx convex env set JWT_PRIVATE_KEY -- "$(cat jwt-private-key.txt)"
npx convex env set JWKS -- "$(cat jwks.txt)"
npx convex env set SITE_URL http://localhost:5173
```

Keep copies of the key files next to the binary; regenerating them later
invalidates all existing sessions.

### 7. Sign up and pair

A fresh backend has an empty database — create a new account in the web app
and pair the daemon again (see the README development flow). The daemon keeps
only deployment metadata in `device.json`; the device token is stored in the
platform's protected credential facility. Linux requires `secret-tool` and an
active Secret Service provider (for example, GNOME Keyring or KWallet), macOS
uses Keychain, and Windows uses the current user's DPAPI profile. If the
platform facility is unavailable, pairing and startup fail closed rather than
writing a plaintext token. Existing legacy `device.json` files are migrated to
the protected store on the next daemon startup.

## Day-to-day

Start the backend script first (once per boot), then `bun run daemon:dev` and
`bun run web:dev` per session. After changing `convex/` code, push with
`bun run convex:dev`.

The real cross-tier recovery profile is protected and explicitly opt-in. This
keeps ordinary `bun run test` deterministic even on machines that have the
self-hosted backend binary installed. Run it alone with:

```bash
RELAY_CROSS_TIER=1 bun test apps/daemon/src/cross-tier-recovery.e2e.test.ts
```

Without the opt-in, the profile is skipped. With the opt-in, missing backend
or loopback prerequisites fail the run instead of producing a false-green
protected job.

### `start-relay-backend.sh` vs `bun run convex:dev`

These are commonly confused but do entirely different jobs:

| | `start-relay-backend.sh` | `bun run convex:dev` |
|---|---|---|
| What it is | The backend **server** — the database process itself | The Convex **CLI deploy tool** |
| What it does | Serves queries/mutations, stores data, streams updates | Pushes `convex/` code (schema, functions, validators) *to* the server |
| When to run | Once per boot, before anything else | Only when `convex/` code changed since the last push |
| If you skip it | Nothing works — connection refused on 3210 | Server keeps serving the previously pushed functions; stale-schema errors like `Could not find public function for …` |

The relationship: the script turns the database on; `convex:dev` installs your
latest backend code into it. With Convex cloud, only the second command existed
(the server was theirs); self-hosting adds the first.

Inspecting data without the dashboard: `npx convex data`, `npx convex run`,
`npx convex logs`, `npx convex env list`.

## Troubleshooting

- **Schema push will fail on the next `bun run convex:dev` / `npx convex
  deploy`** — confirmed 2026-07-23 (read-only check, not fixed): the live
  `pairings` table has two documents predating the `deviceNonce` field
  becoming required, both already `claimed` and expired 2026-07-20. A push
  that validates the current schema against existing documents will reject
  them with `Object is missing the required field 'deviceNonce'`. Fix by
  clearing stale `pairings` rows before the next push, e.g.:
  `echo -n "" > /tmp/empty-pairings.jsonl && npx convex import --table
  pairings --replace --format jsonLines -y /tmp/empty-pairings.jsonl`
  (safe — claimed pairings are historical records with no further use).
  Rehearsed successfully against a disposable restored copy in
  [backup-recovery.md](backup-recovery.md); not yet applied to the live
  instance.
- **`Could not find public function for …`** — deployed functions are stale;
  run `bun run convex:dev`.
- **Connection refused on 3210** — the backend isn't running; start it with
  `~/.local/share/convex-selfhost/start-relay-backend.sh` and check
  `~/.local/share/convex-selfhost/backend.log`.
- **Web/daemon can't authenticate after key regeneration** — expected; sign up
  or sign in again, and re-pair the daemon.
- **`Function execution timed out (maximum duration: 1s)` on sign-in/sign-up**
  — Convex mutations have a hard, non-configurable 1 s limit, and password
  hashing must fit inside it. `convex/auth.ts` uses PBKDF2 via native WebCrypto
  for this reason; the Convex Auth default (pure-JS scrypt) exceeds the limit
  on slow CPUs. If this recurs, lower `PBKDF2_ITERATIONS` in `convex/auth.ts`
  and redeploy. Accounts hashed under a previous scheme cannot sign in and
  must be recreated.
- **Moving machines** — copy the whole `~/.local/share/convex-selfhost/`
  directory (binary, secrets, `relay-data/`); it is fully self-contained.
