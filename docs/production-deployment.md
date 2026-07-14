# Production Deployment

Relay uses Cloudflare Pages for its Vite SPA, Convex for backend/authentication, and GitHub Releases for daemon binaries.

## One-time setup

1. Create a Cloudflare Pages project using Direct Upload. Record its project name as the GitHub environment variable `CLOUDFLARE_PAGES_PROJECT`.
2. Add protected GitHub environment secrets: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (scoped to Pages Write for this account), and `CONVEX_DEPLOY_KEY` (scoped only to Convex `deployment:deploy`).
3. Create/configure the Convex production deployment and its Auth environment values in the Convex dashboard. Do not store any of them in GitHub variables or the repository.
4. Push `main` to deploy. The workflow deploys Convex first, injects its public URL as `VITE_CONVEX_URL` during the SPA build, then uploads `apps/web/dist` to Cloudflare Pages.

## Releases and installation

Tag a commit as `vX.Y.Z` to publish the five daemon binaries, installers, and `checksums.txt` through GitHub Releases.

Linux/macOS:
```bash
curl -fsSL https://github.com/Fchery87/relay/releases/latest/download/relay-install.sh | sh
```

Windows PowerShell:
```powershell
irm https://github.com/Fchery87/relay/releases/latest/download/relay-install.ps1 | iex
```

Then pair and run the daemon:
```bash
$HOME/.local/bin/relay connect --url https://your-production.convex.cloud
$HOME/.local/bin/relay start
```

Set `RELAY_INSTALL_DIR` before running the installer to choose another user-writable directory. Add the chosen directory to `PATH` if you prefer to invoke `relay` without its full path. The pairing command stores the public Convex URL and device token in an owner-only OS configuration directory: `$XDG_CONFIG_HOME/relay` or `~/.config/relay` on Linux, `~/Library/Application Support/Relay` on macOS, and `%APPDATA%\\Relay` on Windows. The URL is public client configuration, not a credential.
