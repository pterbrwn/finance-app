#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${LEDGER_NODE_BIN:-${HOME}/.local/share/ledger/runtimes/node-v24.22.1/bin/node}"
release_root="${LEDGER_RELEASE_ROOT:-${HOME}/.local/share/ledger/releases}"
release_id="${1:-$(git -C "$repo_root" rev-parse --short=12 HEAD)}"

[[ "$release_id" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || { echo "Invalid release identifier." >&2; exit 2; }
[[ -x "$node_bin" && "$("$node_bin" --version)" == "v24.22.1" ]] || { echo "Pinned Node.js 24.22.1 runtime is required." >&2; exit 1; }
command -v git >/dev/null && command -v tar >/dev/null || { echo "Git and tar are required." >&2; exit 1; }
commit_hash="$(git -C "$repo_root" rev-parse --verify "$release_id^{commit}")"
mkdir -p "$release_root"
chmod 755 "$release_root"
if [[ -e "$release_root/$release_id" ]]; then
  echo "Release already exists and is immutable: $release_id" >&2
  exit 1
fi
work_dir="$(mktemp -d "${release_root}/.prepare-${release_id}.XXXXXX")"
trap 'chmod -R u+w "$work_dir" 2>/dev/null || true; rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/source" "$work_dir/release/scripts" "$work_dir/release/dist" "$work_dir/release/deploy"
git -C "$repo_root" archive --format=tar "$release_id" | tar -xf - -C "$work_dir/source"
node_dir="$(dirname "$node_bin")"
PATH="$node_dir:$PATH" "$node_bin" "$node_dir/../lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --prefix "$work_dir/source"
(cd "$work_dir/source" && LEDGER_BUILD_ID="$release_id" "$node_bin" scripts/build.mjs)
cp -R "$work_dir/source/dist/." "$work_dir/release/dist/"
cp "$work_dir/source/package.json" "$work_dir/release/package.json"
cp "$work_dir/source/package-lock.json" "$work_dir/release/package-lock.json"
for file in dev-server.mjs runtime.mjs local-storage.mjs sync.mjs import-legacy-json.mjs sqlite-backup.mjs sqlite-restore.mjs backup-runner.mjs backup-retention.mjs start-ledger.sh start-sync.sh start-backup.sh; do
  cp "$work_dir/source/scripts/$file" "$work_dir/release/scripts/$file"
done
for file in ledger.service ledger-sync.service ledger-sync.timer ledger-backup.service ledger-backup.timer; do
  cp "$work_dir/source/deploy/$file" "$work_dir/release/deploy/$file"
done
PATH="$node_dir:$PATH" "$node_bin" "$node_dir/../lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --prefix "$work_dir/release"
"$node_bin" --input-type=module - "$work_dir/release" "$release_id" "$commit_hash" <<'NODE'
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, buildId, commit] = process.argv.slice(2);
const { SQLITE_SCHEMA_VERSION } = await import(pathToFileURL(join(root, 'dist/server/sqlite-repository.mjs')));
const release = { buildId, commit, nodeVersion: '24.22.1', schemaVersion: SQLITE_SCHEMA_VERSION, minimumSchemaVersion: 1, maximumSchemaVersion: SQLITE_SCHEMA_VERSION };
await writeFile(join(root, 'release.json'), JSON.stringify(release, null, 2) + '\n', { mode: 0o644 });
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) await walk(filename);
    else if (relative(root, filename) !== 'manifest.sha256') files.push(filename);
  }
}
await walk(root);
files.sort();
const manifest = await Promise.all(files.map(async filename => `${createHash('sha256').update(await readFile(filename)).digest('hex')}  ${relative(root, filename)}`));
await writeFile(join(root, 'manifest.sha256'), manifest.join('\n') + '\n', { mode: 0o644 });
NODE
chmod 755 "$work_dir/release/scripts/start-ledger.sh" "$work_dir/release/scripts/start-sync.sh" "$work_dir/release/scripts/start-backup.sh"
(cd "$work_dir/release" && sha256sum -c manifest.sha256)
LEDGER_NODE_BIN="$node_bin" "$node_bin" "$work_dir/source/scripts/check-release.mjs" "$work_dir/release"
chmod -R a-w "$work_dir/release"
chmod u+w "$work_dir/release"
mv "$work_dir/release" "$release_root/$release_id"
chmod -R a-w "$release_root/$release_id"
echo "Prepared immutable release $release_id ($commit_hash) with Node.js 24.22.1 and a verified schema manifest."
