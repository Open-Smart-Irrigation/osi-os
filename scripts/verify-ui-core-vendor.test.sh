#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
verifier="$script_dir/verify-ui-core-vendor.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

canonical_root="$tmp_dir/canonical"
server_root="$tmp_dir/server"
mkdir -p "$canonical_root" "$server_root/frontend/src/ui-core"
printf 'tokens\n' > "$canonical_root/tokens.css"
cp "$canonical_root/tokens.css" "$server_root/frontend/src/ui-core/tokens.css"

CANONICAL_UI_CORE_ROOT="$canonical_root" OSI_SERVER_ROOT="$server_root" sh "$verifier"

printf 'drift\n' >> "$server_root/frontend/src/ui-core/tokens.css"
if CANONICAL_UI_CORE_ROOT="$canonical_root" OSI_SERVER_ROOT="$server_root" sh "$verifier" >/dev/null 2>&1; then
  echo 'expected byte drift to fail' >&2
  exit 1
fi
cp "$canonical_root/tokens.css" "$server_root/frontend/src/ui-core/tokens.css"

rm -rf "$server_root/frontend/src/ui-core"
if CANONICAL_UI_CORE_ROOT="$canonical_root" OSI_SERVER_ROOT="$server_root" sh "$verifier" >/dev/null 2>&1; then
  echo 'expected a missing vendor directory to fail' >&2
  exit 1
fi

echo "verify-ui-core-vendor.test: OK"
