#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${LEDGER_NODE_BIN:-}" ]]; then
  node_bin="$LEDGER_NODE_BIN"
else
  node_bin="${HOME}/.local/share/ledger/runtimes/node-v24.22.1/bin/node"
  if [[ ! -x "$node_bin" ]]; then
    node_bin="$(command -v node || true)"
  fi
fi
[[ -n "$node_bin" && -x "$node_bin" && "$("$node_bin" --version)" == "v24.22.1" ]] || { echo "Pinned Node.js 24.22.1 runtime is required." >&2; exit 1; }
exec "$node_bin" "$@"
