#!/bin/sh
set -eu

install_dir="${RELAY_INSTALL_DIR:-$HOME/.local/bin}"
target="$install_dir/relay"
if [ -e "$target" ]; then
  rm -f -- "$target"
  printf 'Removed Relay from %s\n' "$target"
else
  printf 'Relay is not installed at %s\n' "$target"
fi
