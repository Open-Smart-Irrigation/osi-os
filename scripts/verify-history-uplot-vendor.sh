#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${OSI_SERVER_ROOT:-}" ]]; then
  echo 'OSI_SERVER_ROOT is required (path to the reviewed osi-server checkout)' >&2
  exit 2
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
canonical="$repo_root/web/history-uplot-core"
vendor_root=$(cd "$OSI_SERVER_ROOT" && pwd)/frontend/vendor/history-uplot-core

if [[ ! -d "$canonical" ]]; then
  echo "canonical package is missing: $canonical" >&2
  exit 1
fi
if [[ ! -d "$vendor_root" ]]; then
  echo "cloud vendor package is missing: $vendor_root" >&2
  exit 1
fi

manifest() {
  local root=$1
  (cd "$root" && find . -type d \( -name node_modules -o -name dist -o -name coverage -o -name .cache \) -prune -o -type f -print | sort | while IFS= read -r file; do
    sha256sum "$file"
  done)
}

canonical_manifest=$(mktemp)
vendor_manifest=$(mktemp)
trap 'rm -f "$canonical_manifest" "$vendor_manifest"' EXIT
manifest "$canonical" >"$canonical_manifest"
manifest "$vendor_root" >"$vendor_manifest"

if ! diff -u "$canonical_manifest" "$vendor_manifest"; then
  echo 'history-uplot vendor differs from the canonical package' >&2
  exit 1
fi
echo "history-uplot vendor matches canonical package: $vendor_root"
