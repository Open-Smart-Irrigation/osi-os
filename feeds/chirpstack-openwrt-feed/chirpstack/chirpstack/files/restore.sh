#!/bin/sh
# Standalone LuCI helper. Keep the shared safety functions identical in both scripts.
# OSI_CS_ROOT prefixes filesystem paths for the isolated failure-injection tests.
set -u
umask 077
ROOT=${OSI_CS_ROOT:-}
BASE="$ROOT/srv/backup"
SET="$BASE/chirpstack-set"
PREV="$BASE/chirpstack-set.prev"
LOCK="$BASE/.chirpstack-backup-restore.lock"
REDIS="$ROOT/srv/redis/dump.rdb"
FILES='chirpstack.sqlite chirpstack.sqlite-wal chirpstack.sqlite-shm chirpstack.redis'
TMP=
CHECK=
LOCKED=0
MOVED=
RESTORING=0
PUBLISHING=0
ERROR='unexpected exit'
SUCCESS=
PROBE=

fail() { ERROR=$1; exit 1; }
log() { printf '%s\n' "$*"; }
process_running() {
    case "$1" in
        chirpstack) "$PROBE" chirpstack >/dev/null 2>&1 ;;
        redis) "$PROBE" redis-server >/dev/null 2>&1 ;;
    esac
}
stop_service() {
    service "$1" stop || return 1
    waited=0
    while :; do
        process_running "$1"
        probe_status=$?
        case "$probe_status" in 1) return 0 ;; 0) ;; *) return 1 ;; esac
        [ "$waited" -lt 30 ] || return 1
        sleep 1 || return 1
        waited=$((waited + 1))
    done
}
start_services() {
    start_result=0
    # Try both even when one fails. Repeated starts are idempotent under procd.
    service redis start || start_result=1
    service chirpstack start || start_result=1
    if [ -n "$PROBE" ]; then
        for start_name in redis chirpstack; do
            waited=0
            until process_running "$start_name"; do
                [ "$waited" -lt 30 ] || { start_result=1; break; }
                sleep 1 || { start_result=1; break; }
                waited=$((waited + 1))
            done
        done
    else
        start_result=1
    fi
    return "$start_result"
}
live_path() {
    case "$1" in chirpstack.redis) LIVE=$REDIS ;; *) LIVE="$ROOT/srv/chirpstack/$1" ;; esac
}
hash_file() {
    sum=$(sha256sum "$1") || return 1
    HASH=${sum%% *}
    [ "${#HASH}" -eq 64 ] || return 1
    case "$HASH" in *[!0-9a-f]*) return 1 ;; esac
}
copy_checked() {
    cp -p "$1" "$2" || return 1
    hash_file "$1" || return 1
    source_hash=$HASH
    hash_file "$2" || return 1
    [ "$source_hash" = "$HASH" ]
}
integrity() {
    command -v sqlite3 >/dev/null 2>&1 || return 0
    # SQLite can checkpoint/delete sidecars on close. Never open the published
    # set or the restore staging bytes: validate a second, disposable copy.
    CHECK=$(mktemp -d "$BASE/.chirpstack-check.XXXXXX") || return 1
    chmod 700 "$CHECK" || return 1
    for check_name in chirpstack.sqlite chirpstack.sqlite-wal chirpstack.sqlite-shm; do
        if [ -f "$1/$check_name" ]; then
            copy_checked "$1/$check_name" "$CHECK/$check_name" || return 1
        fi
    done
    check_result=$(sqlite3 "$CHECK/chirpstack.sqlite" 'PRAGMA integrity_check;') || return 1
    [ "$check_result" = ok ] || return 1
    rm -rf "$CHECK" || return 1
    CHECK=
}
write_manifest() {
    : > "$TMP/MANIFEST.sha256" || return 1
    for manifest_name in $FILES; do
        if [ -f "$TMP/$manifest_name" ]; then
            hash_file "$TMP/$manifest_name" || return 1
            printf '%s  %s\n' "$HASH" "$manifest_name" >> "$TMP/MANIFEST.sha256" || return 1
        fi
    done
}
validate_set() {
    [ -f "$1/MANIFEST.sha256" ] && [ ! -L "$1/MANIFEST.sha256" ] || return 1
    seen=' '
    while IFS= read -r line || [ -n "$line" ]; do
        expected=${line%%  *}
        name=${line#*  }
        case "$name" in chirpstack.sqlite|chirpstack.sqlite-wal|chirpstack.sqlite-shm|chirpstack.redis) ;; *) return 1 ;; esac
        [ "$line" = "$expected  $name" ] || return 1
        case "$seen" in *" $name "*) return 1 ;; esac
        seen="$seen$name "
        [ -f "$1/$name" ] && [ ! -L "$1/$name" ] || return 1
        hash_file "$1/$name" || return 1
        [ "$HASH" = "$expected" ] || return 1
    done < "$1/MANIFEST.sha256"
    for required in chirpstack.sqlite chirpstack.redis; do
        case "$seen" in *" $required "*) ;; *) return 1 ;; esac
        [ -s "$1/$required" ] || return 1
    done
    # Include dotfiles in the completeness check, without depending on ls.
    for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        name=${entry##*/}
        [ "$name" != MANIFEST.sha256 ] || continue
        case "$seen" in *" $name "*) ;; *) return 1 ;; esac
    done
}
rollback() {
    # A failed start may have spawned a writer. Prove both stopped again before
    # moving anything back; preserve the originals if that cannot be proved.
    rollback_result=0
    stop_service chirpstack || rollback_result=1
    stop_service redis || rollback_result=1
    [ "$rollback_result" -eq 0 ] || return 1
    if [ "$RESTORING" = 1 ]; then
        # A failed start can create sidecars absent from the backup. All original
        # paths have been moved at this point, so clear every replacement slot.
        for rollback_name in $FILES; do
            live_path "$rollback_name"
            rm -f "$LIVE" || rollback_result=1
        done
    fi
    for rollback_name in $MOVED; do
        live_path "$rollback_name"
        mv "$LIVE.pre-restore-$STAMP" "$LIVE" || rollback_result=1
    done
    return "$rollback_result"
}
finish() {
    result=$?
    trap - 0
    trap '' HUP INT TERM
    if [ "$PUBLISHING" = 1 ] && [ ! -e "$SET" ] && [ -d "$PREV" ]; then
        mv "$PREV" "$SET" || { ERROR="$ERROR; previous set remains at $PREV"; result=1; }
    fi
    if [ -n "$CHECK" ]; then rm -rf "$CHECK" || result=1; fi
    if [ -n "$TMP" ]; then rm -rf "$TMP" || result=1; fi
    # Starting is part of the restore transaction: even a failed start rolls
    # back, after verifying that no newly spawned writer is still running.
    if [ "$result" -eq 0 ]; then
        if ! start_services; then ERROR='restart: service start failed'; result=1; fi
    fi
    if [ "$result" -ne 0 ] && { [ -n "$MOVED" ] || [ "$RESTORING" = 1 ]; }; then
        if rollback; then log 'ROLLED BACK: original SQLite files and Redis dump restored'
        else ERROR="$ERROR; rollback incomplete, originals retained with .pre-restore-$STAMP"; fi
    fi
    if [ "$result" -ne 0 ]; then
        if ! start_services; then ERROR="$ERROR; service start failed"; fi
    fi
    if [ "$LOCKED" = 1 ]; then rmdir "$LOCK" || { ERROR="$ERROR; lock cleanup failed"; result=1; }; fi
    if [ "$result" -eq 0 ]; then log "$SUCCESS"
    else
        state='not running'
        if [ -n "$PROBE" ] && process_running chirpstack; then state=running; fi
        log "ERROR: $ERROR; ChirpStack $state" >&2
    fi
    exit "$result"
}
# LuCI may close its output pipe; still run EXIT recovery.
trap '' PIPE
trap finish 0
trap 'fail "signal: interrupted"' HUP INT TERM
if command -v pidof >/dev/null 2>&1; then PROBE=pidof
elif command -v pgrep >/dev/null 2>&1; then
    # pgrep must match the full process name, not a substring.
    pgrep_exact() { pgrep -x "$1"; }
    PROBE=pgrep_exact
else fail 'preflight: neither pidof nor pgrep is available'; fi
command -v sha256sum >/dev/null 2>&1 || fail 'preflight: sha256sum is unavailable'
mkdir -p "$BASE" || fail 'preflight: cannot create backup directory'
mkdir "$LOCK" || fail 'preflight: backup or restore already running (lock retained after uncatchable interruption)'
LOCKED=1
TMP=$(mktemp -d "$BASE/.chirpstack-stage.XXXXXX") || fail 'preflight: cannot create temporary set'
chmod 700 "$TMP" || fail 'preflight: cannot secure temporary set'
SOURCE=$BASE
if [ -e "$SET" ] || [ -L "$SET" ]; then
    [ -d "$SET" ] && [ ! -L "$SET" ] || fail 'validate: backup set is not a directory'
    SOURCE=$SET
    validate_set "$SOURCE" || fail 'validate: incomplete or corrupt backup manifest'
else
    # Legacy flat files remain accepted, including backups made before WAL.
    for name in chirpstack.sqlite chirpstack.redis; do
        [ -s "$SOURCE/$name" ] || fail "validate: missing or empty backup $name"
    done
fi
# Freeze the validated input before stopping either service. Work exclusively
# from this snapshot afterwards and verify it again against its own manifest.
for name in $FILES; do
    if [ -e "$SOURCE/$name" ]; then
        [ -f "$SOURCE/$name" ] && [ ! -L "$SOURCE/$name" ] || fail "validate: not a regular backup $name"
        copy_checked "$SOURCE/$name" "$TMP/$name" || fail "validate: cannot stage $name"
    fi
done
if [ "$SOURCE" = "$SET" ]; then
    copy_checked "$SOURCE/MANIFEST.sha256" "$TMP/MANIFEST.sha256" || fail 'validate: cannot stage manifest'
else
    write_manifest || fail 'validate: cannot hash legacy backup'
fi
validate_set "$TMP" || fail 'validate: backup changed during staging'
integrity "$TMP" || fail 'integrity: backup SQLite database is not ok'
STAMP=$(date -u +%Y%m%dT%H%M%SZ) || fail 'preflight: cannot read UTC time'
# PID also prevents two restores in the same second from replacing originals.
STAMP="$STAMP-$$"
for name in $FILES; do
    live_path "$name"
    [ ! -e "$LIVE.pre-restore-$STAMP" ] || fail "preflight: recovery path exists for $name"
    if [ -e "$LIVE" ] || [ -L "$LIVE" ]; then
        [ -f "$LIVE" ] && [ ! -L "$LIVE" ] || fail "preflight: not a regular live file $name"
    fi
done
stop_service chirpstack || fail 'stop: ChirpStack did not stop within 30 seconds or stop failed'
stop_service redis || fail 'stop: Redis did not stop within 30 seconds or stop failed'
for name in $FILES; do
    live_path "$name"
    if [ -e "$LIVE" ]; then
        # Ignore catchable signals only over the rename + bookkeeping pair.
        trap '' HUP INT TERM
        if mv "$LIVE" "$LIVE.pre-restore-$STAMP"; then MOVED="$MOVED $name"
        else fail "move: cannot retain original $name"; fi
        trap 'fail "signal: interrupted"' HUP INT TERM
    fi
done
RESTORING=1
for name in $FILES; do
    if [ -f "$TMP/$name" ]; then
        live_path "$name"
        copy_checked "$TMP/$name" "$LIVE" || fail "restore: cannot copy or verify $name"
    fi
done
SUCCESS="OK: restored from $SOURCE"
exit 0
