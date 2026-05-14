#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DEFAULT_HOME="$ROOT_DIR/.local/farming-db"
DEFAULT_INVENTORY="$DEFAULT_HOME/gateways.tsv"
DEFAULT_REMOTE_DB="/data/db/farming.db"

OUTPUT_HOME="${OSI_FARMING_DB_HOME:-$DEFAULT_HOME}"
INVENTORY="$DEFAULT_INVENTORY"
REMOTE_DB="$DEFAULT_REMOTE_DB"
GATEWAY=""
ALL_GATEWAYS=0
LOCAL_DB=""

usage() {
  cat <<'EOF'
Usage:
  scripts/download-farming-db.sh --gateway <name>
  scripts/download-farming-db.sh --all
  scripts/download-farming-db.sh --gateway <name> --local-db <path>

Options:
  --gateway <name>      Download one named gateway.
  --all                 Download every gateway in the inventory.
  --inventory <path>    TSV inventory path. Default: .local/farming-db/gateways.tsv
  --remote-db <path>    Remote SQLite DB path. Default: /data/db/farming.db
  --local-db <path>     Snapshot a local DB file. Intended for fixture/offline verification.
  --output-home <path>  Snapshot root. Default: .local/farming-db
  -h, --help            Show this help.

Inventory TSV columns:
  gateway<TAB>host<TAB>user

Blank lines and lines starting with # are ignored. The user column is optional
and defaults to root.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

sanitize_gateway() {
  case "$1" in
    ''|*[!A-Za-z0-9._-]*)
      die "gateway names may only contain letters, numbers, dot, underscore, and dash"
      ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --gateway)
      [ "$#" -ge 2 ] || die "--gateway requires a value"
      GATEWAY="$2"
      shift 2
      ;;
    --all)
      ALL_GATEWAYS=1
      shift
      ;;
    --inventory)
      [ "$#" -ge 2 ] || die "--inventory requires a value"
      INVENTORY="$2"
      shift 2
      ;;
    --remote-db)
      [ "$#" -ge 2 ] || die "--remote-db requires a value"
      REMOTE_DB="$2"
      shift 2
      ;;
    --local-db)
      [ "$#" -ge 2 ] || die "--local-db requires a value"
      LOCAL_DB="$2"
      shift 2
      ;;
    --output-home)
      [ "$#" -ge 2 ] || die "--output-home requires a value"
      OUTPUT_HOME="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[ "$ALL_GATEWAYS" -eq 1 ] || [ -n "$GATEWAY" ] || die "use --gateway <name> or --all"
[ "$ALL_GATEWAYS" -eq 0 ] || [ -z "$GATEWAY" ] || die "use --gateway or --all, not both"
[ -z "$LOCAL_DB" ] || [ "$ALL_GATEWAYS" -eq 0 ] || die "--local-db can only be used with --gateway"

require_cmd sqlite3
require_cmd awk

mkdir -p "$OUTPUT_HOME"
chmod 700 "$OUTPUT_HOME" 2>/dev/null || true

timestamp_utc() {
  date -u '+%Y%m%dT%H%M%SZ'
}

sqlite_ro() {
  db_path="$1"
  sql="$2"
  sqlite3 "file:$db_path?mode=ro" "$sql"
}

table_exists() {
  db_path="$1"
  table_name="$2"
  sqlite_ro "$db_path" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$table_name';"
}

append_table_metadata() {
  db_path="$1"
  metadata_path="$2"
  table_name="$3"
  timestamp_column="$4"

  exists="$(table_exists "$db_path" "$table_name")"
  if [ "$exists" != "1" ]; then
    printf '%s_rows\tmissing\n' "$table_name" >> "$metadata_path"
    printf '%s_latest_%s\tmissing\n' "$table_name" "$timestamp_column" >> "$metadata_path"
    return
  fi

  rows="$(sqlite_ro "$db_path" "SELECT COUNT(*) FROM \"$table_name\";")"
  latest="$(sqlite_ro "$db_path" "SELECT COALESCE(MAX(\"$timestamp_column\"), 'none') FROM \"$table_name\";")"
  printf '%s_rows\t%s\n' "$table_name" "$rows" >> "$metadata_path"
  printf '%s_latest_%s\t%s\n' "$table_name" "$timestamp_column" "$latest" >> "$metadata_path"
}

write_local_metadata() {
  snapshot_db="$1"
  metadata_path="$2"
  gateway="$3"
  source_kind="$4"
  source_detail="$5"

  quick_check="$(sqlite_ro "$snapshot_db" "PRAGMA quick_check;")"
  file_size="$(wc -c < "$snapshot_db" | tr -d ' ')"

  {
    printf 'gateway\t%s\n' "$gateway"
    printf 'downloaded_at_utc\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'source_kind\t%s\n' "$source_kind"
    printf 'source_detail\t%s\n' "$source_detail"
    printf 'snapshot_file\t%s\n' "$snapshot_db"
    printf 'snapshot_bytes\t%s\n' "$file_size"
    printf 'quick_check\t%s\n' "$quick_check"
  } > "$metadata_path"

  append_table_metadata "$snapshot_db" "$metadata_path" device_data recorded_at
  append_table_metadata "$snapshot_db" "$metadata_path" dendrometer_readings recorded_at
  append_table_metadata "$snapshot_db" "$metadata_path" chameleon_readings recorded_at
  append_table_metadata "$snapshot_db" "$metadata_path" devices updated_at
  append_table_metadata "$snapshot_db" "$metadata_path" irrigation_zones updated_at
}

prepare_snapshot_dir() {
  gateway="$1"
  ts="$2"
  gateway_dir="$OUTPUT_HOME/snapshots/$gateway"
  snapshot_dir="$gateway_dir/$ts"
  mkdir -p "$snapshot_dir"
  chmod 700 "$OUTPUT_HOME/snapshots" "$gateway_dir" "$snapshot_dir" 2>/dev/null || true
  printf '%s\n' "$snapshot_dir"
}

mark_latest() {
  gateway="$1"
  ts="$2"
  gateway_dir="$OUTPUT_HOME/snapshots/$gateway"
  (cd "$gateway_dir" && ln -sfn "$ts" latest)
}

snapshot_local_db() {
  gateway="$1"
  local_db="$2"
  sanitize_gateway "$gateway"
  [ -f "$local_db" ] || die "local DB not found: $local_db"

  ts="$(timestamp_utc)"
  snapshot_dir="$(prepare_snapshot_dir "$gateway" "$ts")"
  snapshot_db="$snapshot_dir/farming.db"
  metadata_path="$snapshot_dir/metadata.tsv"

  sqlite3 "$local_db" ".backup '$snapshot_db'"
  write_local_metadata "$snapshot_db" "$metadata_path" "$gateway" "local-db" "$local_db"
  mark_latest "$gateway" "$ts"

  printf '%s\n' "$snapshot_db"
}

inventory_lookup() {
  name="$1"
  [ -f "$INVENTORY" ] || die "inventory not found: $INVENTORY; copy analysis/farming-db/gateways.example.tsv to .local/farming-db/gateways.tsv"

  awk -F '\t' -v target="$name" '
    $0 !~ /^[[:space:]]*($|#)/ && $1 == target {
      user = ($3 == "" ? "root" : $3)
      print $1 "\t" $2 "\t" user
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' "$INVENTORY" || die "gateway not found in inventory: $name"
}

inventory_names() {
  [ -f "$INVENTORY" ] || die "inventory not found: $INVENTORY; copy analysis/farming-db/gateways.example.tsv to .local/farming-db/gateways.tsv"
  awk -F '\t' '$0 !~ /^[[:space:]]*($|#)/ { print $1 }' "$INVENTORY"
}

remote_snapshot() {
  cat <<'REMOTE'
set -eu
db_path="$1"
remote_dir="$2"
snapshot="$remote_dir/farming.db"
metadata="$remote_dir/remote-metadata.tsv"

umask 077
mkdir -p "$remote_dir"
rm -f "$snapshot"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$db_path" ".backup '$snapshot'"
  method="sqlite3-backup"
elif [ -d /srv/node-red/node_modules/sqlite3 ]; then
  SOURCE_DB="$db_path" TARGET_DB="$snapshot" node <<'NODE'
const sqlite3 = require('/srv/node-red/node_modules/sqlite3');

const source = process.env.SOURCE_DB;
const target = process.env.TARGET_DB;

function quoteSql(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

const db = new sqlite3.Database(source, sqlite3.OPEN_READONLY, (openError) => {
  if (openError) {
    console.error(openError.message);
    process.exit(1);
  }
  db.exec('VACUUM INTO ' + quoteSql(target), (execError) => {
    db.close(() => {
      if (execError) {
        console.error(execError.message);
        process.exit(1);
      }
    });
  });
});
NODE
  method="node-sqlite-vacuum-into"
else
  echo "sqlite3 CLI unavailable and /srv/node-red/node_modules/sqlite3 missing" >&2
  exit 127
fi

test -s "$snapshot"
{
  printf 'snapshot_method\t%s\n' "$method"
  printf 'remote_db_path\t%s\n' "$db_path"
  printf 'remote_snapshot_path\t%s\n' "$snapshot"
  printf 'remote_snapshot_bytes\t%s\n' "$(wc -c < "$snapshot" | tr -d ' ')"
} > "$metadata"
REMOTE
}

snapshot_remote_gateway() {
  gateway="$1"
  host="$2"
  user="$3"
  sanitize_gateway "$gateway"
  [ -n "$host" ] || die "host missing for gateway: $gateway"
  [ -n "$user" ] || user="root"

  require_cmd ssh
  require_cmd scp

  ts="$(timestamp_utc)"
  snapshot_dir="$(prepare_snapshot_dir "$gateway" "$ts")"
  snapshot_db="$snapshot_dir/farming.db"
  metadata_path="$snapshot_dir/metadata.tsv"
  remote_dir="/tmp/osi-farming-db-${gateway}-${ts}-$$"
  ssh_target="$user@$host"

  remote_script="$(mktemp)"
  remote_snapshot > "$remote_script"

  cleanup_remote() {
    ssh "$ssh_target" "rm -rf '$remote_dir'" >/dev/null 2>&1 || true
  }

  if ! ssh "$ssh_target" 'sh -s' -- "$REMOTE_DB" "$remote_dir" < "$remote_script"; then
    rm -f "$remote_script"
    cleanup_remote
    die "remote snapshot failed for $gateway"
  fi
  rm -f "$remote_script"

  if ! scp "$ssh_target:$remote_dir/farming.db" "$snapshot_db" >/dev/null; then
    cleanup_remote
    die "failed to download snapshot for $gateway"
  fi

  if scp "$ssh_target:$remote_dir/remote-metadata.tsv" "$snapshot_dir/remote-metadata.tsv" >/dev/null 2>&1; then
    :
  fi

  cleanup_remote
  write_local_metadata "$snapshot_db" "$metadata_path" "$gateway" "ssh" "$ssh_target:$REMOTE_DB"
  if [ -f "$snapshot_dir/remote-metadata.tsv" ]; then
    cat "$snapshot_dir/remote-metadata.tsv" >> "$metadata_path"
  fi
  mark_latest "$gateway" "$ts"

  printf '%s\n' "$snapshot_db"
}

download_gateway() {
  gateway="$1"
  sanitize_gateway "$gateway"

  if [ -n "$LOCAL_DB" ]; then
    snapshot_local_db "$gateway" "$LOCAL_DB"
    return
  fi

  row="$(inventory_lookup "$gateway")"
  old_ifs="$IFS"
  IFS='	'
  set -- $row
  IFS="$old_ifs"
  snapshot_remote_gateway "$1" "$2" "${3:-root}"
}

if [ -n "$LOCAL_DB" ]; then
  download_gateway "$GATEWAY"
elif [ "$ALL_GATEWAYS" -eq 1 ]; then
  inventory_names | while IFS= read -r gateway_name; do
    [ -n "$gateway_name" ] || continue
    download_gateway "$gateway_name"
  done
else
  download_gateway "$GATEWAY"
fi
