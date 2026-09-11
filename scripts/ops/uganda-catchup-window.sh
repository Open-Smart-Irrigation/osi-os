#!/bin/sh
# Uganda catch-up + baseline + migrate-to-head window (runbook Phase 3).
# Runs ENTIRELY ON-DEVICE, under setsid, logging to a file - never streams
# statements over the SSH/tunnel link. POSIX / BusyBox ash only: no arrays,
# no [[ ]], no `local`, no process substitution, no bashisms. Style matches
# the proven-in-production idioms in deploy.sh's run_schema_migration().
#
# Usage (on-device, after uploading this script + PAYLOAD_DIR's contents):
#   setsid sh /data/db/uganda-catchup-window.sh /data/osi-catchup-payload \
#       > /data/db/catchup-$(date -u +%Y%m%dT%H%M%SZ).log 2>&1 &
#   disown 2>/dev/null || true
#
# PAYLOAD_DIR must contain (fetched ahead of time, matching deploy.sh's
# fetch_migration_runner() list, plus this window's Uganda-specific
# additions):
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
#   UGANDA_CATCHUP_STUB_NODE_RED=1   for local rehearsal only: replace
#       `/etc/init.d/node-red stop|start` with no-op stubs so this script's
#       control flow can be dry-run on a workstation copy that has no
#       Node-RED init script. NEVER set this on the real device.
#
# Exit codes: 0 = success, postflight all-green, Node-RED restarted.
#             1 = failure; migrate-cli restore semantics applied (if it got
#                 that far) or an earlier gate refused; Node-RED restarted
#                 by the trap regardless.
#             2 = usage error before anything touched the DB.

set -eu

PAYLOAD_DIR="${1:?usage: uganda-catchup-window.sh <payload-dir>}"
DB_PATH="${UGANDA_DB_PATH:-/data/db/farming.db}"
BACKUP_DIR="${UGANDA_CATCHUP_BACKUP_DIR:-/data/backups/uganda-catchup}"
COUNTS_FILE="${UGANDA_CATCHUP_COUNTS_FILE:-$BACKUP_DIR/pre-window-counts.tsv}"
MIGRATIONS_DIR="$PAYLOAD_DIR/database/migrations/ordered"
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

# --- exit trap: Node-RED restarted on EVERY exit path -----------------------
NODE_RED_RESTART_NEEDED=0
FINAL_STATUS="did not reach a final status line (script aborted early)"

on_exit() {
    rc=$?
    if [ "$NODE_RED_RESTART_NEEDED" = "1" ]; then
        log "trap: restarting Node-RED (exit path rc=$rc)"
        if node_red_start; then
            log "trap: Node-RED restarted OK"
        else
            log "trap: FATAL - Node-RED failed to restart; manual intervention required"
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

log "=== Uganda catch-up + baseline + migrate-to-head window starting ==="
log "DB: $DB_PATH  payload: $PAYLOAD_DIR  backups: $BACKUP_DIR"

[ -e "$DB_PATH" ] || fail "no database at $DB_PATH"
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 CLI not present"
command -v node >/dev/null 2>&1 || fail "node not present"
[ -d "$MIGRATIONS_DIR" ] || fail "migrations dir not found in payload: $MIGRATIONS_DIR"

mkdir -p "$BACKUP_DIR"

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
