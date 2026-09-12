#!/bin/sh
# Uganda catch-up + baseline + migrate-to-head window (runbook Phase 3).
# Runs ENTIRELY ON-DEVICE, under setsid, logging to a file - never streams
# statements over the SSH/tunnel link. POSIX / BusyBox ash only: no arrays,
# no [[ ]], no `local`, no process substitution, no bashisms. Style matches
# the proven-in-production idioms in deploy.sh's run_schema_migration().
#
# Usage (on-device, after uploading this script + PAYLOAD_DIR's contents):
#   setsid sh /data/db/uganda-catchup-window.sh /data/osi-catchup-payload \
#       [--expected-flows-sha <sha256>] \
#       > /data/db/catchup-$(date -u +%Y%m%dT%H%M%SZ).log 2>&1 &
#   disown 2>/dev/null || true
#
# --expected-flows-sha <sha256> (optional): the sha256 the CURRENTLY-FLIPPED
#   /srv/node-red/flows.json must already match before this window is
#   allowed to touch the database or Node-RED (issue #222 / F4 - see the
#   "flows-flip precondition" section below). If omitted, the same value is
#   computed from PAYLOAD_DIR's own staged
#   conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json instead
#   (so PAYLOAD_DIR should include it unless --expected-flows-sha is given).
#
# PAYLOAD_DIR must contain (fetched ahead of time, matching deploy.sh's
# fetch_migration_runner() list, plus this window's Uganda-specific
# additions):
#   conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
#       (only required as the --expected-flows-sha fallback - see above)
#   scripts/uganda-catchup-20260911.sql                   (the additive catch-up artifact - static, piped directly to sqlite3)
#   scripts/ops/uganda-schema-rebuild-20260911.sql         (the table-rebuild artifact - read by the orchestrator below via __dirname, never piped directly)
#   scripts/ops/generate-uganda-schema-rebuild-20260911.js (guarded orchestrator for the above; kept under scripts/ops/
#                                                            - NOT flattened to scripts/ - because its own
#                                                            require('../../lib/...') and
#                                                            require('../semantic-schema-compare') depend on the
#                                                            same two-level relative depth it has in this repo)
#   scripts/repair-sync-outbox-v2.js
#   scripts/baseline-existing-db.js
#   scripts/verify-head-cli.js
#   scripts/semantic-schema-compare.js
#   scripts/migrate-cli.js
#   lib/osi-migrate/{backup,fingerprints,index,ledger,migrations-loader,runner-iface,runner,sql-normalize}.js
#   database/migrations/ordered/  (CHECKSUMS.json + every 00NN__*.sql)
#
# Order (runbook Phase 2 rehearsal finding, then Phase-3 design
# docs/superpowers/specs/2026-09-11-uganda-schema-reconciliation-design.md):
# additive catch-up artifact -> table-rebuild artifact (the 17 residual,
# non-additive diffs the catch-up artifact deliberately does not touch) ->
# repair-sync-outbox-v2 -> baseline-existing-db -> migrate-cli. The
# table-rebuild artifact runs its OWN guarded preflight (exact drift-signature
# match, per-table already-canonical skip, orphan/NULL/drift data guards) via
# generate-uganda-schema-rebuild-20260911.js --apply - see that file's header
# and the design doc for what each guard protects against.
#
# Env overrides (all optional):
#   UGANDA_DB_PATH          default /data/db/farming.db
#   UGANDA_CATCHUP_BACKUP_DIR  default /data/backups/uganda-catchup
#   UGANDA_CATCHUP_COUNTS_FILE default $UGANDA_CATCHUP_BACKUP_DIR/pre-window-counts.tsv
#   UGANDA_LIVE_FLOWS_PATH  default /srv/node-red/flows.json - the
#       currently-flipped flows payload checked by the flows-flip
#       precondition (override only for local rehearsal against a
#       workstation fixture; NEVER on the real device).
#   UGANDA_EXPECTED_FLOWS_SHA  same effect as --expected-flows-sha; the CLI
#       argument wins if both are given.
#   UGANDA_CATCHUP_STUB_NODE_RED=1   for local rehearsal only: replace
#       `/etc/init.d/node-red stop|start` with no-op stubs so this script's
#       control flow can be dry-run on a workstation copy that has no
#       Node-RED init script. NEVER set this on the real device.
#   UGANDA_CATCHUP_WINDOW_TEST_SOURCE=1  test-only: `.`-source this script
#       (rather than run it) to get every function/trap/default defined
#       without executing the on-device main body - lets
#       uganda-catchup-window.test.sh exercise the exit trap's restart gate
#       in isolation. NEVER set this on the real device.
#
# Exit codes: 0 = success, postflight all-green, Node-RED restarted.
#             1 = failure; migrate-cli restore semantics applied (if it got
#                 that far) or an earlier gate refused; Node-RED restarted
#                 by the trap ONLY if the flows-flip precondition held (see
#                 below) - otherwise the trap leaves Node-RED stopped.
#             2 = usage error before anything touched the DB.

set -eu

[ $# -ge 1 ] || { echo "usage: uganda-catchup-window.sh <payload-dir> [--expected-flows-sha <sha256>]" >&2; exit 2; }
PAYLOAD_DIR="$1"
shift
EXPECTED_FLOWS_SHA="${UGANDA_EXPECTED_FLOWS_SHA:-}"
while [ $# -gt 0 ]; do
    case "$1" in
        --expected-flows-sha)
            [ $# -ge 2 ] || { echo "ERROR: --expected-flows-sha requires a value" >&2; exit 2; }
            EXPECTED_FLOWS_SHA="$2"
            shift 2
            ;;
        --expected-flows-sha=*)
            EXPECTED_FLOWS_SHA="${1#--expected-flows-sha=}"
            shift
            ;;
        *)
            echo "ERROR: unknown argument: $1" >&2
            exit 2
            ;;
    esac
done
DB_PATH="${UGANDA_DB_PATH:-/data/db/farming.db}"
BACKUP_DIR="${UGANDA_CATCHUP_BACKUP_DIR:-/data/backups/uganda-catchup}"
COUNTS_FILE="${UGANDA_CATCHUP_COUNTS_FILE:-$BACKUP_DIR/pre-window-counts.tsv}"
MIGRATIONS_DIR="$PAYLOAD_DIR/database/migrations/ordered"
LIVE_FLOWS_PATH="${UGANDA_LIVE_FLOWS_PATH:-/srv/node-red/flows.json}"
BUNDLE_FLOWS_PATH="$PAYLOAD_DIR/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Row-count invariant tables (runbook Phase 2 postflight list, plus the
# bookkeeping tables this window itself touches).
INVARIANT_TABLES="device_data chameleon_readings dendrometer_readings dendrometer_daily irrigation_events zone_daily_environment zone_daily_recommendations analysis_views irrigation_schedules devices users irrigation_zones valve_actuation_expectations zone_irrigation_calibration zone_weather_cache"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# --- Node-RED stop/start, stubbable for local rehearsal only ---------------
node_red_stop() {
    if [ "${UGANDA_CATCHUP_STUB_NODE_RED:-0}" = "1" ]; then
        log "STUB: node-red stop (UGANDA_CATCHUP_STUB_NODE_RED=1)"
        return 0
    fi
    /etc/init.d/node-red stop
}

node_red_start() {
    if [ "${UGANDA_CATCHUP_STUB_NODE_RED:-0}" = "1" ]; then
        log "STUB: node-red start (UGANDA_CATCHUP_STUB_NODE_RED=1)"
        return 0
    fi
    /etc/init.d/node-red start
}

node_red_wait_stopped() {
    if [ "${UGANDA_CATCHUP_STUB_NODE_RED:-0}" = "1" ]; then
        return 0
    fi
    wait_s=0
    while command -v pgrep >/dev/null 2>&1 && pgrep -f 'node-red' >/dev/null 2>&1 && [ "$wait_s" -lt 30 ]; do
        sleep 1
        wait_s=$((wait_s + 1))
    done
    if command -v pgrep >/dev/null 2>&1 && pgrep -f 'node-red' >/dev/null 2>&1; then
        log "ERROR: Node-RED did not stop within 30s"
        return 1
    fi
}

# --- exit trap: Node-RED restarted on EVERY exit path, but ONLY when the
# flows-flip precondition held at entry (issue #222 / F4). This is the
# "safe by construction" half of the fix: regardless of WHY
# NODE_RED_RESTART_NEEDED ends up "1" on some future exit path, the trap
# itself refuses to start Node-RED unless FLOWS_PRECONDITION_OK was
# explicitly set by verify_flows_flipped_precondition() below - so a restart
# can never run the PREVIOUS release's boot node against a schema this
# window already migrated. ---------------------------------------------
NODE_RED_RESTART_NEEDED=0
FLOWS_PRECONDITION_OK=0
FINAL_STATUS="did not reach a final status line (script aborted early)"

on_exit() {
    rc=$?
    if [ "$NODE_RED_RESTART_NEEDED" = "1" ]; then
        if [ "$FLOWS_PRECONDITION_OK" = "1" ]; then
            log "trap: restarting Node-RED (exit path rc=$rc)"
            if node_red_start; then
                log "trap: Node-RED restarted OK"
            else
                log "trap: FATAL - Node-RED failed to restart; manual intervention required"
            fi
        else
            log "trap: REFUSE-TO-RESTART (issue #222 / F4) - the flows-flip precondition was not satisfied at entry, so starting Node-RED now could run the PREVIOUS release's boot node against a migrated schema. Leaving Node-RED STOPPED."
            log "trap: RECOVERY - if the database was already touched, restore the on-device backup logged above; otherwise run the flows-only deploy (or deploy.sh) to flip /srv/node-red/flows.json to the migration target first. THEN start Node-RED manually: /etc/init.d/node-red start"
        fi
    fi
    log "FINAL: $FINAL_STATUS (rc=$rc)"
    exit "$rc"
}
trap on_exit EXIT INT TERM

fail() {
    FINAL_STATUS="FAILED: $1"
    log "ERROR: $1"
    exit 1
}

# --- record row counts (used for the pre-window snapshot AND the postflight
# comparison; same function, two call sites) ---------------------------------
record_counts() {
    dest="$1"
    : > "$dest"
    for t in $INVARIANT_TABLES; do
        present="$(sqlite3 "$DB_PATH" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$t' LIMIT 1;")"
        if [ "$present" = "1" ]; then
            n="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM $t;")"
        else
            n="ABSENT"
        fi
        echo "$t	$n" >> "$dest"
    done
}

# --- flows-flip precondition (issue #222 / F4) ------------------------------
# The 2026-09-12 Uganda incident: this window migrated the schema, then its
# trap restarted Node-RED - but the flows-only deploy that should have
# flipped /srv/node-red/flows.json to the migration target had only STAGED
# its payload ("flip deferred"). The OLD boot node ran against the NEW
# schema, hit a `devices` CHECK it didn't recognise, and its unfenced
# `devices` rebuild cascade-deleted all of `device_data`. The runbook's
# Phase 0 already tells the operator to deploy+restart onto the current
# flows before running this window; this function ENFORCES that, rather
# than trusting the checklist, by sha256-comparing the currently-flipped
# flows.json against the migration target BEFORE anything else in this
# script touches the database or Node-RED. A mismatch (or an inability to
# determine the target at all) REFUSE-AND-HOLDs: rc=1, nothing touched.
verify_flows_flipped_precondition() {
    if [ -n "$EXPECTED_FLOWS_SHA" ]; then
        expected="$EXPECTED_FLOWS_SHA"
        expected_source="--expected-flows-sha argument"
    elif [ -f "$BUNDLE_FLOWS_PATH" ]; then
        expected="$(sha256sum "$BUNDLE_FLOWS_PATH" | awk '{print $1}')"
        expected_source="staged bundle flows.json ($BUNDLE_FLOWS_PATH)"
    else
        fail "REFUSE-AND-HOLD (issue #222 / F4): cannot verify the flows-flip precondition - no --expected-flows-sha given and no staged bundle flows.json at $BUNDLE_FLOWS_PATH. Pass --expected-flows-sha <sha256>, or include conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json in the payload, then retry. Node-RED has NOT been touched."
    fi

    [ -f "$LIVE_FLOWS_PATH" ] || fail "REFUSE-AND-HOLD (issue #222 / F4): cannot verify the flows-flip precondition - no live flows.json at $LIVE_FLOWS_PATH. Node-RED has NOT been touched."
    live_sha="$(sha256sum "$LIVE_FLOWS_PATH" | awk '{print $1}')"

    if [ "$live_sha" != "$expected" ]; then
        fail "REFUSE-AND-HOLD (issue #222 / F4): the currently-flipped flows payload ($LIVE_FLOWS_PATH, sha256 $live_sha) does not match the migration target ($expected_source, sha256 $expected). Run the flows-only deploy (deploy.sh, letting it flip the payload) and confirm Node-RED is stable on it FIRST, then retry this window - never restart Node-RED against a newly-migrated schema while it is still running an older flows payload. Node-RED has NOT been touched."
    fi
    log "flows-flip precondition ok: $LIVE_FLOWS_PATH matches $expected_source (sha256 $live_sha)"
    FLOWS_PRECONDITION_OK=1
}

# --- Test hook: `.`-source this script (UGANDA_CATCHUP_WINDOW_TEST_SOURCE=1)
# to get every function/trap/default defined above without running the
# on-device main body below - lets uganda-catchup-window.test.sh drive
# on_exit()'s restart gate directly. NEVER set this on the real device.
if [ "${UGANDA_CATCHUP_WINDOW_TEST_SOURCE:-0}" = "1" ]; then
    return 0 2>/dev/null || exit 0
fi

log "=== Uganda catch-up + baseline + migrate-to-head window starting ==="
log "DB: $DB_PATH  payload: $PAYLOAD_DIR  backups: $BACKUP_DIR"

[ -e "$DB_PATH" ] || fail "no database at $DB_PATH"
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 CLI not present"
command -v node >/dev/null 2>&1 || fail "node not present"
[ -d "$MIGRATIONS_DIR" ] || fail "migrations dir not found in payload: $MIGRATIONS_DIR"

verify_flows_flipped_precondition

mkdir -p "$BACKUP_DIR"

# --- disk-space preflight: fail closed BEFORE Node-RED is stopped ----------
# Worst case this window transiently holds an on-device .backup, a
# migrate-cli persistent backup, AND (during a table rebuild) both the old
# and new copy of whichever table is being rebuilt at once - conservatively
# budgeted as 3x the DB's current size (see the design doc's "disk headroom"
# section for the 2x-per-rebuild-pass rationale; the 3rd multiple covers the
# two backups landing in the same window). +64 MB covers fixed overhead
# (WAL/SHM sidecars, the payload itself, logs) that doesn't scale with DB
# size. Uses `df -Pk` (POSIX output format - one header line, one data line,
# no long-devicename line wrapping) and shell parameter expansion instead of
# `dirname`/`bc`, so it needs nothing beyond what deploy.sh already assumes
# is present on a BusyBox ash gateway.
db_dir="${DB_PATH%/*}"
[ "$db_dir" = "$DB_PATH" ] && db_dir="."
db_bytes="$(wc -c < "$DB_PATH")" || fail "could not stat $DB_PATH for the disk-space preflight"
db_kb=$((db_bytes / 1024))
required_kb=$((db_kb * 3 + 65536))
avail_kb="$(df -Pk "$db_dir" | awk 'NR==2{print $4}')"
if [ -z "$avail_kb" ]; then
    fail "disk-space preflight: could not parse \`df -Pk $db_dir\` output - refusing to proceed without a headroom check"
fi
if [ "$avail_kb" -lt "$required_kb" ]; then
    fail "disk-space preflight: only ${avail_kb}KB free on $db_dir, need >= ${required_kb}KB (3x DB size ${db_kb}KB + 64MB headroom) - free up space before retrying this window"
fi
log "disk-space preflight ok: ${avail_kb}KB free on $db_dir, need >= ${required_kb}KB"

log "--- pre-window row-count snapshot -> $COUNTS_FILE ---"
record_counts "$COUNTS_FILE"
cat "$COUNTS_FILE"

log "--- stop Node-RED ---"
node_red_stop || fail "node-red stop failed"
node_red_wait_stopped || fail "node-red did not stop"
NODE_RED_RESTART_NEEDED=1

log "--- on-device backup (.backup, kept locally AND already exfiltrated off-device in Phase 1) ---"
ONDEVICE_BACKUP="$BACKUP_DIR/farming.db.catchup-$STAMP"
sqlite3 "$DB_PATH" ".backup '$ONDEVICE_BACKUP'" || fail "on-device .backup failed"
integ="$(sqlite3 "$ONDEVICE_BACKUP" 'PRAGMA integrity_check;')"
[ "$integ" = "ok" ] || fail "on-device backup integrity_check failed: $integ"
log "on-device backup ok: $ONDEVICE_BACKUP"

log "--- apply catch-up artifact ---"
sqlite3 "$DB_PATH" < "$PAYLOAD_DIR/scripts/uganda-catchup-20260911.sql" || fail "catch-up artifact apply failed"
integ="$(sqlite3 "$DB_PATH" 'PRAGMA integrity_check;')"
[ "$integ" = "ok" ] || fail "post-catchup integrity_check failed: $integ"

log "--- apply table-rebuild artifact (the 17 residual non-additive diffs) ---"
# `set -e` does not fire on a command used as an if-condition, so this is
# the ash-safe way to capture a non-zero exit status without aborting the
# script before the rc-specific handling below can distinguish the two
# failure classes.
if node "$PAYLOAD_DIR/scripts/ops/generate-uganda-schema-rebuild-20260911.js" --apply "$DB_PATH"; then
    rebuild_rc=0
else
    rebuild_rc=$?
fi
if [ "$rebuild_rc" = "1" ]; then
    # REFUSE-AND-HOLD: a known precondition failed (drift signature mismatch,
    # or an orphan/NULL/drift data guard) BEFORE any DDL ran - the DB is
    # untouched. Re-run the audit off-device, fix or triage the data, and
    # retry this window; do NOT restore a backup, there is nothing to undo.
    fail "REBUILD-REFUSED: table-rebuild artifact refused before making any change (preflight guard - see its own log lines above for which one) - re-run scripts/ops/uganda-schema-audit.js off-device to diagnose before retrying this window"
elif [ "$rebuild_rc" != "0" ]; then
    # Anything else (rc=2, a genuine crash mid-DDL) - SQLite's own
    # transaction rollback means the DB is very likely intact, but this is
    # NOT one of the tool's own examined preflight refusals, so treat it as
    # a structural surprise: stop and have an operator restore the
    # pre-rebuild on-device backup taken above before retrying.
    fail "REBUILD-CRASHED (rc=$rebuild_rc): table-rebuild artifact failed unexpectedly during apply - restore the pre-rebuild backup ($ONDEVICE_BACKUP) before retrying; do not assume the transaction rollback alone is sufficient without operator review"
fi
integ="$(sqlite3 "$DB_PATH" 'PRAGMA integrity_check;')"
[ "$integ" = "ok" ] || fail "post-rebuild integrity_check failed: $integ"
fk_rows="$(sqlite3 "$DB_PATH" 'PRAGMA foreign_key_check;' | wc -l)"
[ "$fk_rows" -eq 0 ] || fail "post-rebuild foreign_key_check found $fk_rows violation(s)"

log "--- repair-sync-outbox-v2 ---"
node "$PAYLOAD_DIR/scripts/repair-sync-outbox-v2.js" "$DB_PATH" || fail "repair-sync-outbox-v2 failed"

log "--- baseline-existing-db (stamp the ledger) ---"
if ! node "$PAYLOAD_DIR/scripts/baseline-existing-db.js" "$DB_PATH" --migrations-dir "$MIGRATIONS_DIR"; then
    fail "baseline-existing-db could not find a matching reference(N) - refusing to migrate. Re-run --report off-device to diagnose before retrying this window."
fi

log "--- migrate-cli (backup-dir=$BACKUP_DIR) ---"
if ! node "$PAYLOAD_DIR/scripts/migrate-cli.js" "$DB_PATH" --backup-dir "$BACKUP_DIR" --migrations-dir "$MIGRATIONS_DIR"; then
    fail "migrate-cli failed; it applies its own byte-image restore internally for destructive/data migrations before returning"
fi

log "--- postflight: integrity_check ---"
integ="$(sqlite3 "$DB_PATH" 'PRAGMA integrity_check;')"
[ "$integ" = "ok" ] || fail "postflight integrity_check failed: $integ"

log "--- postflight: foreign_key_check (expect zero rows) ---"
fk_rows="$(sqlite3 "$DB_PATH" 'PRAGMA foreign_key_check;' | wc -l)"
[ "$fk_rows" -eq 0 ] || fail "postflight foreign_key_check found $fk_rows violation(s)"

log "--- postflight: verify-head ---"
head_json="$(node "$PAYLOAD_DIR/scripts/verify-head-cli.js" "$DB_PATH" --migrations-dir "$MIGRATIONS_DIR")" || fail "verify-head reported not-ok: $head_json"
log "verify-head: $head_json"

log "--- postflight: row-count invariants vs pre-window snapshot ---"
POST_COUNTS_FILE="$BACKUP_DIR/post-window-counts-$STAMP.tsv"
record_counts "$POST_COUNTS_FILE"
mismatch=0
while IFS="$(printf '\t')" read -r tbl before_n; do
    after_n="$(awk -F'\t' -v t="$tbl" '$1==t{print $2}' "$POST_COUNTS_FILE")"
    if [ "$before_n" = "ABSENT" ]; then
        log "  $tbl: ABSENT before -> $after_n after (newly created by migrate; not a violation)"
        continue
    fi
    if [ "$before_n" != "$after_n" ]; then
        log "  MISMATCH $tbl: before=$before_n after=$after_n"
        mismatch=1
    else
        log "  ok $tbl: $before_n == $after_n"
    fi
done < "$COUNTS_FILE"
[ "$mismatch" -eq 0 ] || fail "row-count invariant violated (see MISMATCH lines above)"

FINAL_STATUS="OK: catch-up + baseline + migrate-to-head all green; postflight all-green; row counts identical"
log "$FINAL_STATUS"
exit 0
