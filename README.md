# Relay

Relay is a browser control surface for a local coding-agent daemon. It pairs a locally running daemon with the Convex-backed workspace and renders its machine state in the web sidebar.

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
