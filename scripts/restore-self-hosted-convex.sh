#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Restore a self-hosted Convex + daemon backup into an ISOLATED staging
# directory (never the live convex-selfhost or daemon home) and verify
# manifest checksums. Mechanical restore + checksum verification only —
# functional acceptance (schema deploy, sign-in, pairing, daemon reconnect,
# projection reconciliation) is a manual follow-up per
# docs/operations/backup-recovery.md until an automated staging-acceptance
# harness exists.
#
# Usage:
#   scripts/restore-self-hosted-convex.sh --backup DIR --staging DIR [--verify-only]
# ---------------------------------------------------------------------------
set -euo pipefail

BACKUP_DIR=""
STAGING_DIR=""
VERIFY_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP_DIR="$2"; shift 2 ;;
    --staging) STAGING_DIR="$2"; shift 2 ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$BACKUP_DIR" || -z "$STAGING_DIR" ]]; then
  echo "Usage: $0 --backup DIR --staging DIR [--verify-only]" >&2
  exit 1
fi
if [[ ! -f "$BACKUP_DIR/manifest.json" ]]; then
  echo "No manifest.json found in $BACKUP_DIR — not a valid backup produced by backup-self-hosted-convex.sh" >&2
  exit 1
fi

# Refuse to restore into a live, in-use location — staging must be isolated.
for live in "$HOME/.local/share/convex-selfhost" "$HOME/.config/relay" "${RELAY_CONVEX_SELFHOST_HOME:-}" "${RELAY_DAEMON_HOME:-}"; do
  [[ -z "$live" ]] && continue
  live_real="$(realpath "$live" 2>/dev/null || echo "$live")"
  staging_real="$(realpath -m "$STAGING_DIR" 2>/dev/null || echo "$STAGING_DIR")"
  if [[ "$staging_real" == "$live_real" ]]; then
    echo "Refusing to restore into a live location: $STAGING_DIR matches $live" >&2
    exit 1
  fi
done

echo "Verifying manifest checksums..."
FAILED=0
while IFS= read -r line; do
  path=$(echo "$line" | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')
  expected=$(echo "$line" | sed -n 's/.*"sha256": "\([^"]*\)".*/\1/p')
  [[ -z "$path" ]] && continue
  actual=$(sha256sum "$BACKUP_DIR/$path" | cut -d' ' -f1)
  if [[ "$actual" != "$expected" ]]; then
    echo "  CHECKSUM MISMATCH: $path (expected $expected, got $actual)" >&2
    FAILED=1
  fi
done < <(grep '"path"' "$BACKUP_DIR/manifest.json")

if [[ "$FAILED" -eq 1 ]]; then
  echo "Backup integrity check FAILED — refusing to restore a corrupted backup." >&2
  exit 1
fi
echo "All checksums verified."

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  echo "Verify-only requested — no files copied."
  exit 0
fi

mkdir -p "$STAGING_DIR"
cp -a "$BACKUP_DIR"/. "$STAGING_DIR"/
chmod -R go-rwx "$STAGING_DIR"

INSTANCE_NAME=$(sed -n 's/.*"instanceName": "\([^"]*\)".*/\1/p' "$STAGING_DIR/manifest.json")
INSTANCE_NAME="${INSTANCE_NAME:-convex-self-hosted}"

cat <<EOF

Restored into isolated staging: $STAGING_DIR

Manual functional acceptance (per docs/operations/backup-recovery.md):
  1. Start a self-hosted backend pointed at $STAGING_DIR/convex/convex_local_backend.sqlite3
     on a non-default port, using the SAME --instance-name as the original
     ($INSTANCE_NAME) — the admin key is cryptographically bound to
     instance-name + instance-secret together, so renaming the instance
     invalidates the restored admin key even though the secret matches:
       $STAGING_DIR/../convex-local-backend $STAGING_DIR/convex/convex_local_backend.sqlite3 \\
         --instance-name $INSTANCE_NAME --port 3220 --site-proxy-port 3221 \\
         --instance-secret "\$(cat $STAGING_DIR/convex/instance-secret.txt)" \\
         --local-storage $STAGING_DIR/convex/convex_local_storage
  2. Deploy schema/functions against it and confirm sign-in, pairing, and
     project/thread reads work against the restored data.
  3. Point a daemon at $STAGING_DIR/daemon as its home directory and confirm
     it reconnects and reopens relay-kernel.sqlite cleanly.
  4. Confirm no secret from this restore appears in any log or diagnostic
     export produced during the above steps.
  5. Tear down the staging backend and delete $STAGING_DIR when finished —
     it holds a live copy of production-equivalent credentials.
EOF
