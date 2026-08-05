#!/usr/bin/env sh
set -eu

if [ -z "${OSI_SERVER_ROOT:-}" ]; then
  echo "OSI_SERVER_ROOT is required (path to an osi-server checkout on the AgroLink branch)" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
canonical_file=${CANONICAL_JOURNAL_CATALOG:-"$repo_root/docs/contracts/journal-catalog/journal-catalog.json"}
vendor_file="$OSI_SERVER_ROOT/backend/src/main/resources/journal-catalog/journal-catalog.json"

for file in "$canonical_file" "$vendor_file"; do
  if [ ! -f "$file" ] || [ ! -s "$file" ]; then
    echo "missing or empty journal catalog artifact: $file" >&2
    exit 1
  fi
done

if ! cmp -s "$canonical_file" "$vendor_file"; then
  echo "vendored journal catalog (osi-server backend/src/main/resources/journal-catalog) differs from canonical docs/contracts/journal-catalog" >&2
  exit 1
fi

echo "verify-journal-catalog-vendor: OK"
