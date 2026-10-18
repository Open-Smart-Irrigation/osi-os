#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/frontend/vendor"
cp -a "$repo_root/web/history-uplot-core" "$fixture/frontend/vendor/history-uplot-core"

if OSI_SERVER_ROOT="$fixture" "$repo_root/scripts/verify-history-uplot-vendor.sh" >/dev/null; then
  :
else
  echo 'expected an identical fixture vendor to pass' >&2
  exit 1
fi

printf '\nfixture mutation\n' >>"$fixture/frontend/vendor/history-uplot-core/package.json"
if OSI_SERVER_ROOT="$fixture" "$repo_root/scripts/verify-history-uplot-vendor.sh" >/dev/null 2>&1; then
  echo 'expected a mutated fixture vendor to fail' >&2
  exit 1
fi
echo 'history-uplot vendor verifier red/green fixture passed'
