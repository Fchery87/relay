#!/bin/sh
set -eu

base_url="${RELAY_RELEASE_BASE_URL:-https://github.com/Fchery87/relay/releases/latest/download}"
install_dir="${RELAY_INSTALL_DIR:-$HOME/.local/bin}"
case "$install_dir" in
  /bin|/sbin|/usr/bin|/usr/sbin|/usr/local/bin)
    printf 'Refusing to install into a system directory: %s\n' "$install_dir" >&2
    exit 1
    ;;
esac
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) printf 'Unsupported OS\n' >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) printf 'Unsupported architecture\n' >&2; exit 1 ;; esac
asset="relay-${os}-${arch}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT
curl -fsSL "$base_url/$asset" -o "$tmp_dir/$asset"
curl -fsSL "$base_url/checksums.txt" -o "$tmp_dir/checksums.txt"
curl -fsSL "$base_url/checksums.txt.sig" -o "$tmp_dir/checksums.txt.sig"
curl -fsSL "$base_url/release-public-key.pem" -o "$tmp_dir/release-public-key.pem"
if ! command -v openssl >/dev/null; then
  printf 'OpenSSL is required to verify the signed release\n' >&2
  exit 1
fi
if ! openssl dgst -sha256 -verify "$tmp_dir/release-public-key.pem" -signature "$tmp_dir/checksums.txt.sig" "$tmp_dir/checksums.txt" >/dev/null 2>&1; then
  printf 'Release signature verification failed\n' >&2
  exit 1
fi
expected="$(awk -v asset="$asset" '$2 == asset { print $1 }' "$tmp_dir/checksums.txt")"
if [ -z "$expected" ]; then
  printf 'Missing checksum for %s\n' "$asset" >&2
  exit 1
fi
if command -v sha256sum >/dev/null; then actual="$(sha256sum "$tmp_dir/$asset" | awk '{print $1}')"; else actual="$(shasum -a 256 "$tmp_dir/$asset" | awk '{print $1}')"; fi
if [ "$actual" != "$expected" ]; then
  printf 'Checksum verification failed\n' >&2
  exit 1
fi
mkdir -p "$install_dir"
install -m 0755 "$tmp_dir/$asset" "$install_dir/relay"
printf 'Installed Relay to %s/relay\n' "$install_dir"
printf 'Run: %s/relay connect --url <your-convex-url>\n' "$install_dir"
