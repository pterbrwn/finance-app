#!/usr/bin/env bash
set -euo pipefail
umask 0077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node_bin="${LEDGER_NODE_BIN:-${HOME}/.local/share/ledger/runtimes/node-v24.22.1/bin/node}"
data_dir="${LEDGER_LOCAL_DATA_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/ledger}"

[[ -x "$node_bin" && "$("$node_bin" --version)" == "v24.22.1" ]] || { echo "Pinned Node.js 24.22.1 runtime is required." >&2; exit 1; }
command -v flock >/dev/null || { echo "The Linux flock utility is required." >&2; exit 1; }
mkdir -p "$data_dir/backups"
chmod 700 "$data_dir" "$data_dir/backups"
exec flock -n -F "$data_dir/backups/backup.lock" "$node_bin" "$script_dir/backup-runner.mjs"
