#!/usr/bin/env bash
set -euo pipefail

bash "$(dirname "${BASH_SOURCE[0]}")/run-node.sh" "$(dirname "${BASH_SOURCE[0]}")/build.mjs"
