#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Back up the complete self-hosted Convex execution system: the backend's
# SQLite data root and file storage, its instance credentials, and the
# daemon's local SQLite/WAL orchestration state — everything required to
# restore into an isolated staging deployment per
# docs/operations/backup-recovery.md.
#
# Usage:
#   scripts/backup-self-hosted-convex.sh [--out DIR] [--convex-home DIR] [--daemon-home DIR] [--instance-name NAME] [--no-secrets]
#
# Defaults: --convex-home ~/.local/share/convex-selfhost
#           --daemon-home ~/.config/relay (override with RELAY_DAEMON_HOME)
#           --instance-name convex-self-hosted (must match what restore starts with —
#             the admin key is cryptographically bound to instance-name + instance-secret
#             together; renaming the instance invalidates the restored admin key)
#           --out ./relay-backups/<timestamp>
# ---------------------------------------------------------------------------
set -euo pipefail

CONVEX_HOME="${RELAY_CONVEX_SELFHOST_HOME:-$HOME/.local/share/convex-selfhost}"
DAEMON_HOME="${RELAY_DAEMON_HOME:-$HOME/.config/relay}"
INSTANCE_NAME="convex-self-hosted"
OUT_DIR=""
INCLUDE_SECRETS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --convex-home) CONVEX_HOME="$2"; shift 2 ;;
    --daemon-home) DAEMON_HOME="$2"; shift 2 ;;
    --instance-name) INSTANCE_NAME="$2"; shift 2 ;;
    --no-secrets) INCLUDE_SECRETS=0; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${OUT_DIR:-./relay-backups/$TIMESTAMP}"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

echo "Backing up self-hosted Convex + daemon state to: $OUT_DIR"

sqlite_backup() {
  local src="$1" dest="$2"
  if [[ ! -f "$src" ]]; then
    echo "  (skip) $src does not exist"
    return
  fi
  if command -v sqlite3 >/dev/null 2>&1; then
    # Online-safe backup — consistent even if the source is being written to.
    sqlite3 "$src" ".backup '$dest'"
  else
    echo "  WARNING: sqlite3 CLI not found; falling back to a raw file copy of $src." >&2
    echo "  This is NOT safe against a concurrently-writing process (possible torn read)." >&2
    cp "$src" "$dest"
  fi
}

# 1. Convex backend SQLite data root
mkdir -p "$OUT_DIR/convex"
sqlite_backup "$CONVEX_HOME/relay-data/convex_local_backend.sqlite3" "$OUT_DIR/convex/convex_local_backend.sqlite3"

# 2. Convex file storage
if [[ -d "$CONVEX_HOME/relay-data/convex_local_storage" ]]; then
  cp -a "$CONVEX_HOME/relay-data/convex_local_storage" "$OUT_DIR/convex/convex_local_storage"
else
  echo "  (skip) no convex_local_storage directory"
fi

# 3. Required credentials — instance secret + admin key. Mode 600, only if requested.
if [[ "$INCLUDE_SECRETS" -eq 1 ]]; then
  for f in instance-secret.txt admin-key.txt jwt-private-key.txt jwks.txt; do
    if [[ -f "$CONVEX_HOME/$f" ]]; then
      cp "$CONVEX_HOME/$f" "$OUT_DIR/convex/$f"
      chmod 600 "$OUT_DIR/convex/$f"
    fi
  done
  echo "  Included instance/admin/auth credentials — keep this backup at least as protected as the live instance."
else
  echo "  Skipped credentials per --no-secrets — this backup alone cannot restore a working instance."
fi

# 4. Daemon-local state (device credentials, project/worktree registry, kernel SQLite)
mkdir -p "$OUT_DIR/daemon"
for f in device.json projects.json worktrees.json; do
  if [[ -f "$DAEMON_HOME/$f" ]]; then
    cp "$DAEMON_HOME/$f" "$OUT_DIR/daemon/$f"
    chmod 600 "$OUT_DIR/daemon/$f"
  fi
done
sqlite_backup "$DAEMON_HOME/relay-kernel.sqlite" "$OUT_DIR/daemon/relay-kernel.sqlite"

# 5. Manifest — checksums + freshness for restore verification.
MANIFEST="$OUT_DIR/manifest.json"
{
  echo "{"
  echo "  \"createdAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"convexHome\": \"$CONVEX_HOME\","
  echo "  \"daemonHome\": \"$DAEMON_HOME\","
  echo "  \"instanceName\": \"$INSTANCE_NAME\","
  echo "  \"includesSecrets\": $([ "$INCLUDE_SECRETS" -eq 1 ] && echo true || echo false),"
  echo "  \"files\": ["
  first=1
  while IFS= read -r -d '' f; do
    rel="${f#"$OUT_DIR"/}"
    sha="$(sha256sum "$f" | cut -d' ' -f1)"
    [[ "$first" -eq 1 ]] && first=0 || echo ","
    printf '    {"path": "%s", "sha256": "%s"}' "$rel" "$sha"
  done < <(find "$OUT_DIR" -type f ! -name manifest.json -print0 | sort -z)
  echo ""
  echo "  ]"
  echo "}"
} > "$MANIFEST"

echo "Backup complete: $OUT_DIR"
echo "Manifest: $MANIFEST"
echo "Verify with: scripts/restore-self-hosted-convex.sh --backup $OUT_DIR --staging <isolated-staging-dir> --verify-only"
