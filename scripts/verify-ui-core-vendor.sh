#!/bin/sh
set -eu

if [ -z "${OSI_SERVER_ROOT:-}" ]; then
  echo "OSI_SERVER_ROOT is required (path to an osi-server checkout on the AgroLink branch)" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
canonical_root=${CANONICAL_UI_CORE_ROOT:-"$repo_root/web/react-gui/src/ui-core"}
vendor_root="$OSI_SERVER_ROOT/frontend/src/ui-core"

for dir in "$canonical_root" "$vendor_root"; do
  if [ ! -d "$dir" ] || [ -z "$(ls -A "$dir")" ]; then
    echo "missing or empty ui-core directory: $dir" >&2
    exit 1
  fi
done

if ! diff -ru "$canonical_root" "$vendor_root"; then
  echo "vendored ui-core (osi-server frontend/src/ui-core) differs from canonical web/react-gui/src/ui-core" >&2
  exit 1
fi

echo "verify-ui-core-vendor: OK"
