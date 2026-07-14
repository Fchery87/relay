# Production Distribution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship Relay as verified cross-platform daemon binaries, installable from GitHub Releases, and deploy its static SPA and Convex backend to production through Cloudflare Pages and GitHub Actions.

**Architecture:** A single compiled `relay` CLI dispatches `connect` and `start`. Pairing stores the public Convex deployment URL together with the device token in the daemon's owner-only config file, so the installed daemon needs no recurring environment variables. A tag workflow produces release artifacts; a separate deployment workflow pushes Convex then directly uploads the already-built Vite SPA to Cloudflare Pages.

**Tech Stack:** Bun single-file executables, TypeScript, POSIX shell, PowerShell, GitHub Actions, GitHub Releases, Cloudflare Pages direct upload through Wrangler, Convex deploy keys.

### Task 1: Make the daemon CLI production-ready

**Files:**
- Create: `apps/daemon/src/cli.ts`
- Create: `apps/daemon/src/cli.test.ts`
- Modify: `apps/daemon/src/index.ts`
- Modify: `apps/daemon/src/connect.ts`
- Modify: `apps/daemon/src/device-credentials.ts`
- Modify: `apps/daemon/src/device-credentials.test.ts`
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/config.test.ts`
- Modify: `apps/daemon/package.json`

1. Write CLI tests covering `--help`, an unknown command, `connect --url`, and default/start dispatch without starting the daemon loop.
2. Run `bun test apps/daemon/src/cli.test.ts` and confirm it fails because the dispatcher is absent.
3. Extract `runDaemon` from `index.ts` behind an `import.meta.main` guard; keep signal handling and current work-loop behavior unchanged.
4. Implement `cli.ts` with `relay connect [--url URL]`, `relay start`, and `--help`; reject unrecognized flags and commands.
5. Extend the restrictive persisted credentials record with an optional `deploymentUrl`, accepting existing token-only files for upgrade safety.
6. Make `runConnect` prefer a CLI URL, then `RELAY_CONVEX_URL`, and persist the successful pairing URL. Make daemon config prefer that stored URL before its environment fallback.
7. Point the package `bin` entry at `src/cli.ts`, run focused daemon tests, then typecheck.

### Task 2: Build reproducible cross-platform artifacts

**Files:**
- Create: `scripts/build-release.ts`
- Create: `scripts/build-release.test.ts`
- Create: `scripts/smoke-daemon.ts`
- Modify: `package.json`
- Modify: `.gitignore`

1. Write a failing target-manifest test asserting the five required artifacts: linux x64/arm64, macOS x64/arm64, and Windows x64.
2. Implement a typed target manifest using Bun's documented `--compile --target` values. Use baseline x64 targets where Bun provides them to avoid AVX2-only binaries.
3. Build to `dist/release/` with deterministic artifact names and create a sorted SHA-256 checksum manifest without recording credentials.
4. Add a smoke command that runs each native binary with `--help`, with its platform-specific executable extension.
5. Add root scripts for release build, native smoke build, and release checksum verification. Ignore generated `dist/` output.
6. Run the target-manifest test, artifact build, local native smoke test, and typecheck.

### Task 3: Provide portable installers and operational documentation

**Files:**
- Create: `scripts/install.sh`
- Create: `scripts/install.ps1`
- Create: `scripts/install.test.ts`
- Create: `docs/production-deployment.md`
- Modify: `README.md`

1. Write tests for platform/architecture selection, release-URL construction, checksum-line parsing, and unsafe installation directory rejection.
2. Implement the POSIX installer for Linux/macOS and the PowerShell installer for Windows. Both resolve the latest GitHub Release asset, download its checksum manifest, verify SHA-256, install to a configurable user bin directory, and never require elevated privileges.
3. If `RELAY_CONVEX_URL` is set, installers finish by showing the precise `relay connect --url` command; otherwise, they show the required URL flag without embedding a deployment secret.
4. Document Cloudflare Pages project creation, GitHub/Cloudflare/Convex secrets, production Convex auth configuration, release installation, `relay connect`, and foreground `relay start` operation.
5. Run the installer tests and shell syntax validation; run PowerShell parser validation when a PowerShell executable is available.

### Task 4: Add CI, releases, and production deployment workflows

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `.github/workflows/deploy-production.yml`
- Modify: `tickets.md`

1. Add a pull-request/push CI workflow with a Linux/macOS/Windows matrix. Each job installs Bun, runs typecheck and tests, builds a native executable, and smoke-tests `relay --help`.
2. Add a tag-only release workflow that builds all five release targets, verifies checksums, uploads an intermediate artifact, and creates a GitHub Release using only `contents: write` permission.
3. Add a protected production deployment workflow for `main` and manual dispatch. It uses `CONVEX_DEPLOY_KEY` with `npx convex deploy --cmd-url-env-var-name VITE_CONVEX_URL --cmd 'bun run --cwd apps/web build'`, then uses a scoped Cloudflare Pages API token and account ID to upload `apps/web/dist` via Wrangler.
4. Include no secrets in workflow files. Declare each required secret in documentation and fail closed if absent.
5. Validate workflow action versions with the repository's available tooling or inspect the YAML structure locally.
6. Mark all Production distribution items complete in `tickets.md` only after local verification passes.

### Task 5: Verify and complete

1. Run focused CLI, release-script, and installer tests.
2. Run `bun run typecheck`, `bun run test`, `bun run build`, and `git diff --check`.
3. Inspect the complete diff for secret leakage, unverified downloads, unsafe shell expansion, and release-permission overreach.
4. Use the code-review workflow, commit all ticket files, and keep the feature branch for review.
