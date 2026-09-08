#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
verifier="$script_dir/verify-journal-catalog-vendor.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

vendor_dir="$work/server/backend/src/main/resources/journal-catalog"
mkdir -p "$vendor_dir"
printf '{"catalog_version":10}\n' > "$work/canonical.json"
cp "$work/canonical.json" "$vendor_dir/journal-catalog.json"

CANONICAL_JOURNAL_CATALOG="$work/canonical.json" OSI_SERVER_ROOT="$work/server" \
  sh "$verifier" >/dev/null

printf '{"catalog_version":9}\n' > "$vendor_dir/journal-catalog.json"
if CANONICAL_JOURNAL_CATALOG="$work/canonical.json" OSI_SERVER_ROOT="$work/server" \
     sh "$verifier" >/dev/null 2>&1; then
  echo 'verify-journal-catalog-vendor.test: FAIL — drift was not detected' >&2
  exit 1
fi

: > "$vendor_dir/journal-catalog.json"
if CANONICAL_JOURNAL_CATALOG="$work/canonical.json" OSI_SERVER_ROOT="$work/server" \
     sh "$verifier" >/dev/null 2>&1; then
  echo 'verify-journal-catalog-vendor.test: FAIL — empty vendor file was accepted' >&2
  exit 1
fi

rm -f "$vendor_dir/journal-catalog.json"
if CANONICAL_JOURNAL_CATALOG="$work/canonical.json" OSI_SERVER_ROOT="$work/server" \
     sh "$verifier" >/dev/null 2>&1; then
  echo 'verify-journal-catalog-vendor.test: FAIL — a missing vendor file was accepted' >&2
  exit 1
fi

echo "verify-journal-catalog-vendor.test: OK"
