#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

export OSI_FARMING_DB_HOME="$WORK_DIR/farming-db"

"$ROOT_DIR/scripts/download-farming-db.sh" \
  --gateway seed-fixture \
  --local-db "$ROOT_DIR/database/farming.db"

snapshot="$(find "$OSI_FARMING_DB_HOME/snapshots/seed-fixture" -mindepth 2 -maxdepth 2 -name farming.db -type f | sort | tail -n 1)"
test -n "$snapshot"
test -s "$snapshot"

sqlite3 "file:$snapshot?mode=ro" "PRAGMA quick_check;" | grep -qx ok

metadata_dir="$(dirname "$snapshot")"
test -f "$metadata_dir/metadata.tsv"
grep -q '^device_data_rows	2696$' "$metadata_dir/metadata.tsv"
grep -q '^quick_check	ok$' "$metadata_dir/metadata.tsv"

OSI_FARMING_DB_TEST_GATEWAY=seed-fixture \
  Rscript "$ROOT_DIR/analysis/farming-db/test-load-device-data.R" "$snapshot"

echo "farming DB R workflow verification passed"
