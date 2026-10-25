#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node_bin="${LEDGER_NODE_BIN:-${HOME}/.local/share/ledger/runtimes/node-v24.22.1/bin/node}"
if [[ ! -x "$node_bin" || "$("$node_bin" --version)" != "v24.22.1" ]]; then
  echo "Pinned Node.js 24.22.1 runtime is missing or invalid." >&2
  exit 1
fi
exec "$node_bin" "$script_dir/sync.mjs"
