#!/usr/bin/env bash
set -euo pipefail

release_root="${LEDGER_RELEASE_ROOT:-${HOME}/.local/share/ledger/releases}"
current_link="${LEDGER_CURRENT_LINK:-${HOME}/.local/share/ledger/current}"
node_bin="${LEDGER_NODE_BIN:-${HOME}/.local/share/ledger/runtimes/node-v24.22.1/bin/node}"
data_dir="${LEDGER_LOCAL_DATA_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/ledger}"
health_url="${LEDGER_HEALTH_URL:-http://127.0.0.1:${PORT:-3001}}"
systemctl_bin="${LEDGER_SYSTEMCTL_BIN:-systemctl}"
health_attempts="${LEDGER_HEALTH_ATTEMPTS:-30}"
health_interval="${LEDGER_HEALTH_INTERVAL_SECONDS:-1}"
release_id="${1:-}"
[[ "$release_id" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || { echo "Pass a valid release identifier." >&2; exit 2; }
target="$release_root/$release_id"
[[ -x "$node_bin" && "$("$node_bin" --version)" == "v24.22.1" ]] || { echo "Pinned Node.js 24.22.1 runtime is required." >&2; exit 1; }
[[ -f "$target/release.json" && -f "$target/manifest.sha256" && -f "$target/dist/server/index.js" ]] || { echo "Prepared release not found: $release_id" >&2; exit 1; }
(cd "$target" && sha256sum -c manifest.sha256 >/dev/null) || { echo "Release checksum verification failed." >&2; exit 1; }
release_json="$(cat "$target/release.json")"
expected_build="$("$node_bin" -e "process.stdout.write(JSON.parse(process.argv[1]).buildId)" "$release_json")"
[[ "$expected_build" == "$release_id" ]] || { echo "Release identity does not match its directory name." >&2; exit 1; }

previous_target=""
if [[ -L "$current_link" ]]; then previous_target="$(readlink -f "$current_link")"; fi
switch_link() {
  local destination="$1" next_link="${current_link}.next.$$"
  ln -s "$destination" "$next_link"
  mv -Tf "$next_link" "$current_link"
}
mkdir -p "$(dirname "$current_link")"
switch_link "$target"

if "$systemctl_bin" --user restart ledger.service; then
  for _ in $(seq 1 "$health_attempts"); do
    if health="$(curl -fsS --max-time 2 "$health_url/api/health" 2>/dev/null)" && \
      printf '%s' "$health" | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const h=JSON.parse(s),r=JSON.parse(process.argv[1]);process.exit(h.codeVersion===r.buildId&&Number.isInteger(h.schemaVersion)&&h.schemaVersion>=r.minimumSchemaVersion&&h.schemaVersion<=r.maximumSchemaVersion?0:1)}catch{process.exit(1)}})' "$release_json" && \
      curl -fsS --max-time 2 "$health_url/assets/app.js" -o /dev/null; then
      echo "Activated release $release_id; health, schema, and static asset checks passed."
      exit 0
    fi
    sleep "$health_interval"
  done
fi

echo "Release $release_id failed restart or health verification." >&2
if [[ -n "$previous_target" && -f "$previous_target/release.json" ]]; then
  if "$node_bin" --input-type=module - "$previous_target" "$data_dir/ledger.sqlite" <<'NODE'
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';
const [releaseRoot,databasePath]=process.argv.slice(2);
const release=JSON.parse(await (await import('node:fs/promises')).readFile(join(releaseRoot,'release.json'),'utf8'));
let schema=null;
try {
  await stat(databasePath);
  const modulePath=pathToFileURL(join(releaseRoot,'node_modules/better-sqlite3/lib/index.js'));
  const imported=await import(modulePath);const db=new imported.default(databasePath,{readonly:true,fileMustExist:true});
  try { schema=db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version??0; } finally { db.close(); }
} catch(error) {
  if(error.code==='ENOENT')schema=null;
  else process.exit(1);
}
if(schema!==null&&(schema<release.minimumSchemaVersion||schema>release.maximumSchemaVersion))process.exit(1);
NODE
  then
    switch_link "$previous_target"
    if "$systemctl_bin" --user restart ledger.service; then
      echo "Restored compatible code target $previous_target; the current database was preserved." >&2
    else
      echo "Compatible prior code target restored, but its service restart failed." >&2
      exit 1
    fi
  else
    "$systemctl_bin" --user stop ledger.service || true
    echo "Prior code cannot safely read the current schema. Service stopped; database preserved for explicit recovery." >&2
    exit 1
  fi
else
  "$systemctl_bin" --user stop ledger.service || true
  echo "No prior prepared release exists. Service stopped; candidate remains selected for inspection." >&2
  exit 1
fi
exit 1
