#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
verifier="$script_dir/verify-ui-core-vendor.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

canonical_root="$tmp_dir/canonical"
server_root="$tmp_dir/server"
mkdir -p "$canonical_root" "$server_root/frontend/src/ui-core"
printf 'button\n' > "$canonical_root/Button.tsx"
cp "$canonical_root/Button.tsx" "$server_root/frontend/src/ui-core/Button.tsx"

CANONICAL_UI_CORE_ROOT="$canonical_root" OSI_SERVER_ROOT="$server_root" sh "$verifier"

printf 'drift\n' >> "$server_root/frontend/src/ui-core/Button.tsx"
if CANONICAL_UI_CORE_ROOT="$canonical_root" OSI_SERVER_ROOT="$server_root" sh "$verifier" >/dev/null 2>&1; then
  echo 'expected byte drift in a shared primitive to fail' >&2
  exit 1
fi
cp "$canonical_root/Button.tsx" "$server_root/frontend/src/ui-core/Button.tsx"

# tokens.css and tailwind-preset.js are each side's own file, excluded from
# the diff (osi-os wave-3 port, 2026-09-09) -- drift there must NOT fail.
printf 'osi-os tokens\n' > "$canonical_root/tokens.css"
printf 'osi-server tokens, deliberately different\n' > "$server_root/frontend/src/ui-core/tokens.css"
printf 'osi-os preset\n' > "$canonical_root/tailwind-preset.js"
printf 'osi-server preset, deliberately different\n' > "$server_root/frontend/src/ui-core/tailwind-preset.js"
CANONICAL_UI_CORE_ROOT="$canonical_root" OSI_SERVER_ROOT="$server_root" sh "$verifier"
rm -f "$canonical_root/tokens.css" "$server_root/frontend/src/ui-core/tokens.css" \
      "$canonical_root/tailwind-preset.js" "$server_root/frontend/src/ui-core/tailwind-preset.js"

rm -rf "$server_root/frontend/src/ui-core"
if CANONICAL_UI_CORE_ROOT="$canonical_root" OSI_SERVER_ROOT="$server_root" sh "$verifier" >/dev/null 2>&1; then
  echo 'expected a missing vendor directory to fail' >&2
  exit 1
fi

echo "verify-ui-core-vendor.test: OK"
