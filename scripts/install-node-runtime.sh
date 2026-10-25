#!/usr/bin/env bash
set -euo pipefail

version="24.22.1"
checksum="dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e"
runtime_root="${LEDGER_RUNTIME_ROOT:-${HOME}/.local/share/ledger/runtimes}"
install_dir="$runtime_root/node-v$version"

case "$(uname -m)" in
  aarch64|arm64) archive_name="node-v$version-linux-arm64.tar.xz" ;;
  *) echo "This pinned runtime installer currently supports ARM64 only." >&2; exit 1 ;;
esac
if [[ -x "$install_dir/bin/node" ]]; then
  [[ "$("$install_dir/bin/node" --version)" == "v$version" ]] || { echo "Existing runtime path has the wrong version." >&2; exit 1; }
  echo "Pinned Node.js $version is already installed."
  exit 0
fi
command -v curl >/dev/null && command -v sha256sum >/dev/null && command -v tar >/dev/null || { echo "curl, sha256sum, and tar are required." >&2; exit 1; }
mkdir -p "$runtime_root"
chmod 700 "$runtime_root"
work_dir="$(mktemp -d "$runtime_root/.node-install.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
curl -fsSL "https://nodejs.org/dist/v$version/$archive_name" -o "$work_dir/$archive_name"
printf '%s  %s\n' "$checksum" "$work_dir/$archive_name" | sha256sum --check --status
tar -xJf "$work_dir/$archive_name" -C "$work_dir"
mv "$work_dir/node-v$version-linux-arm64" "$install_dir"
[[ "$("$install_dir/bin/node" --version)" == "v$version" ]] || { echo "Installed runtime version check failed." >&2; exit 1; }
echo "Installed checksum-verified Node.js $version at $install_dir"
