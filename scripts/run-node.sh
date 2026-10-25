#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${LEDGER_NODE_BIN:-${HOME}/.local/share/ledger/runtimes/node-v24.22.1/bin/node}"
[[ -x "$node_bin" && "$("$node_bin" --version)" == "v24.22.1" ]] || { echo "Pinned Node.js 24.22.1 runtime is required." >&2; exit 1; }
exec "$node_bin" "$@"
