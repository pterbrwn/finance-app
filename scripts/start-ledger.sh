#!/usr/bin/env bash
set -euo pipefail
umask 0077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node_bin="${LEDGER_NODE_BIN:-${HOME}/.local/share/ledger/runtimes/node-v24.22.1/bin/node}"
data_dir="${LEDGER_LOCAL_DATA_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/ledger}"

if [[ ! -x "$node_bin" ]]; then
  echo "Pinned Node.js 24.22.1 runtime is missing: $node_bin" >&2
  exit 1
fi
if [[ "$("$node_bin" --version)" != "v24.22.1" ]]; then
  echo "Ledger requires its pinned Node.js 24.22.1 runtime." >&2
  exit 1
fi
command -v flock >/dev/null || { echo "The Linux flock utility is required." >&2; exit 1; }
mkdir -p "$data_dir"
chmod 700 "$data_dir"
export LEDGER_WRITER_LOCKED=1
exec flock -n -F "$data_dir/server.lock" "$node_bin" "$script_dir/dev-server.mjs"
