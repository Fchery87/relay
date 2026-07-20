# Self-hosted Convex backend

Relay's backend runs on a **self-hosted Convex instance** — the same open-source
code Convex cloud runs, as a single prebuilt binary with SQLite storage. No
Docker, no cloud account, no usage limits. The deployment serves the web app,
the daemon, and the Convex CLI exactly like a cloud deployment; the `convex/`
code is identical either way.

- Backend API (`CONVEX_URL`): `http://127.0.0.1:3210`
- HTTP actions (`CONVEX_SITE_URL`): `http://127.0.0.1:3211`
- Install root: `~/.local/share/convex-selfhost/`
- Data: SQLite + file storage under `~/.local/share/convex-selfhost/relay-data/`
  (back this directory up; it is the entire database)

## One-time setup on a new machine

### 1. Download the binary

Grab the latest `convex-local-backend-<arch>.zip` from the
[convex-backend releases](https://github.com/get-convex/convex-backend/releases):

```bash
mkdir -p ~/.local/share/convex-selfhost/relay-data
cd ~/.local/share/convex-selfhost
curl -sLO https://github.com/get-convex/convex-backend/releases/latest/download/convex-local-backend-x86_64-unknown-linux-gnu.zip
unzip convex-local-backend-x86_64-unknown-linux-gnu.zip && chmod +x convex-local-backend
```

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

Health check: `curl http://127.0.0.1:3210/version` should respond. Stop a
detached backend with `pkill -f convex-local-backend`; data persists across
restarts.

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
and pair the daemon again (see the README development flow). Device
credentials land in `~/.config/relay/device.json` on Linux.

## Day-to-day

Start the backend script first (once per boot), then `bun run daemon:dev` and
`bun run web:dev` per session. After changing `convex/` code, push with
`bun run convex:dev`.

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
