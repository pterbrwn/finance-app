#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${LEDGER_NODE_BIN:-${HOME}/.local/share/ledger/runtimes/node-v24.22.1/bin/node}"
release_root="${LEDGER_RELEASE_ROOT:-${HOME}/.local/share/ledger/releases}"
release_id="${1:-$(git -C "$repo_root" rev-parse --short=12 HEAD)}"

[[ "$release_id" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || { echo "Invalid release identifier." >&2; exit 2; }
[[ -x "$node_bin" && "$("$node_bin" --version)" == "v24.22.1" ]] || { echo "Pinned Node.js 24.22.1 runtime is required." >&2; exit 1; }
command -v git >/dev/null && command -v tar >/dev/null || { echo "Git and tar are required." >&2; exit 1; }
mkdir -p "$release_root"
chmod 755 "$release_root"
if [[ -e "$release_root/$release_id" ]]; then
  echo "Release already exists and is immutable: $release_id" >&2
  exit 1
fi
work_dir="$(mktemp -d "${release_root}/.prepare-${release_id}.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/source" "$work_dir/release/scripts" "$work_dir/release/dist"
git -C "$repo_root" archive --format=tar "$release_id" | tar -xf - -C "$work_dir/source"
(cd "$work_dir/source" && LEDGER_BUILD_ID="$release_id" "$node_bin" scripts/build.mjs)
cp -R "$work_dir/source/dist/." "$work_dir/release/dist/"
cp "$work_dir/source/package.json" "$work_dir/release/package.json"
for file in dev-server.mjs runtime.mjs local-storage.mjs sync.mjs start-ledger.sh start-sync.sh; do
  cp "$work_dir/source/scripts/$file" "$work_dir/release/scripts/$file"
done
printf '{"buildId":"%s","node":"24.22.1"}\n' "$release_id" > "$work_dir/release/release.json"
chmod 644 "$work_dir/release/release.json"
chmod 755 "$work_dir/release/scripts/start-ledger.sh" "$work_dir/release/scripts/start-sync.sh"
mv "$work_dir/release" "$release_root/$release_id"
echo "Prepared immutable release $release_id at $release_root/$release_id"
