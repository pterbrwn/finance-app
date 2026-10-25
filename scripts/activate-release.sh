#!/usr/bin/env bash
set -euo pipefail

release_root="${LEDGER_RELEASE_ROOT:-${HOME}/.local/share/ledger/releases}"
current_link="${LEDGER_CURRENT_LINK:-${HOME}/.local/share/ledger/current}"
release_id="${1:-}"
[[ "$release_id" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || { echo "Pass a valid release identifier." >&2; exit 2; }
target="$release_root/$release_id"
[[ -f "$target/release.json" && -f "$target/dist/server/index.js" ]] || { echo "Prepared release not found: $release_id" >&2; exit 1; }
mkdir -p "$(dirname "$current_link")"
next_link="${current_link}.next.$$"
ln -s "$target" "$next_link"
mv -Tf "$next_link" "$current_link"
echo "Activated code symlink for release $release_id. Restart ledger.service to load it."
