#!/bin/sh
# Standalone LuCI helper. Keep the shared safety functions identical in both scripts.
# Restore reports and keeps the newest pre-restore generation after verified
# success; older generations are pruned then. Incomplete recovery never prunes.
# After an interrupted printed recovery, rerun its entire block. A kernel
# process lock checks exclusive ownership before clearing an empty abandoned
# claim. Never delete the permanent .chirpstack-recovery.guard file.
# OSI_CS_ROOT prefixes filesystem paths for the isolated failure-injection tests.
set -u
umask 077
ROOT=${OSI_CS_ROOT:-}
BASE="$ROOT/srv/backup"
SET="$BASE/chirpstack-set"
PREV="$BASE/chirpstack-set.prev"
LOCK="$BASE/.chirpstack-maintenance.lock"
REDIS="$ROOT/srv/redis/dump.rdb"
FILES='chirpstack.sqlite chirpstack.sqlite-wal chirpstack.sqlite-shm chirpstack.sqlite-journal chirpstack.redis'
TMP=
CHECK=
LOCKED=0
STOP_CHIRPSTACK=0
STOP_REDIS=0
STAMP=
MOVED=
UNCLEAR_MOVES=
ORIGINAL_FILES=
ORIGINAL_MANIFEST=
ORIGINALS_RECORDED=0
ORIGINAL_INVENTORY=0
ORIGINAL_MANIFEST_READY=0
ROLLED_BACK=0
RECOVERY_INCOMPLETE=0
RESTORING=0
PUBLISHING=0
PUBLISHED=0
PUBLISH_STAGE=
PUBLISH_MANIFEST_HASH=
PUBLISH_PROVEN_ABSENT=1
LEGACY_ARCHIVE=
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
    # Record the attempt before a stop that may change state and then fail.
    case "$1" in chirpstack) STOP_CHIRPSTACK=1 ;; redis) STOP_REDIS=1 ;; esac
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
    [ "$STOP_REDIS" = 0 ] || service redis start || start_result=1
    [ "$STOP_CHIRPSTACK" = 0 ] || service chirpstack start || start_result=1
    [ "$STOP_REDIS$STOP_CHIRPSTACK" != 00 ] || return 0
    [ -n "$PROBE" ] || return 1
    waited=0
    while :; do
        # Recheck both in each iteration: a service seen earlier may have exited.
        redis_status=0
        chirpstack_status=0
        if [ "$STOP_REDIS" = 1 ]; then process_running redis; redis_status=$?; fi
        if [ "$STOP_CHIRPSTACK" = 1 ]; then process_running chirpstack; chirpstack_status=$?; fi
        [ "$redis_status$chirpstack_status" != 00 ] || break
        case "$redis_status:$chirpstack_status" in 0:1|1:0|1:1) ;; *) return 1 ;; esac
        [ "$waited" -lt 30 ] || return 1
        sleep 1 || return 1
        waited=$((waited + 1))
    done
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
    for check_name in chirpstack.sqlite chirpstack.sqlite-wal chirpstack.sqlite-shm chirpstack.sqlite-journal; do
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
        case "$name" in chirpstack.sqlite|chirpstack.sqlite-wal|chirpstack.sqlite-shm|chirpstack.sqlite-journal|chirpstack.redis) ;; *) return 1 ;; esac
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
record_originals() {
    # Capture presence before any fallible hash. A partial hash record must
    # never turn an unrecorded original into an originally absent file.
    if [ "$ORIGINAL_INVENTORY" = 0 ]; then
        ORIGINAL_FILES=
        for inventory_name in $FILES; do
            live_path "$inventory_name"
            if [ -e "$LIVE" ] || [ -L "$LIVE" ]; then ORIGINAL_FILES="$ORIGINAL_FILES $inventory_name"; fi
        done
        ORIGINAL_INVENTORY=1
    fi
    # Backup publication consumes staging. A later restart failure still needs
    # a private hash record, never extra files inside the published set.
    if [ -z "$TMP" ] || [ ! -d "$TMP" ]; then
        TMP=$(mktemp -d "$BASE/.chirpstack-stage.XXXXXX") || return 1
        chmod 700 "$TMP" || return 1
    fi
    ORIGINAL_MANIFEST="$TMP/ORIGINAL.sha256"
    if [ "$ORIGINAL_MANIFEST_READY" = 0 ]; then
        : > "$ORIGINAL_MANIFEST" || return 1
        ORIGINAL_MANIFEST_READY=1
    fi
    for inventory_name in $ORIGINAL_FILES; do
        live_path "$inventory_name"
        [ -f "$LIVE" ] && [ ! -L "$LIVE" ] || return 1
        if original_hash "$inventory_name"; then
            hash_matches "$LIVE" "$ORIGINAL_HASH" || return 1
        else
            hash_file "$LIVE" || return 1
            printf '%s  %s\n' "$HASH" "$inventory_name" >> "$ORIGINAL_MANIFEST" || return 1
        fi
    done
    verify_live "$ORIGINAL_MANIFEST" || return 1
    ORIGINALS_RECORDED=1
}
original_hash() {
    ORIGINAL_HASH=
    [ -f "$ORIGINAL_MANIFEST" ] || return 1
    while read -r original_expected original_name; do
        if [ "$original_name" = "$1" ]; then ORIGINAL_HASH=$original_expected; return 0; fi
    done < "$ORIGINAL_MANIFEST"
    return 1
}
hash_matches() {
    [ -f "$1" ] && [ ! -L "$1" ] && hash_file "$1" && [ "$HASH" = "$2" ]
}
classify_live_move() {
    # A failed mv can still have renamed the file. Both paths and the original
    # hash must prove the outcome before recovery can change service state.
    MOVE_OUTCOME=unclear
    if [ ! -e "$1" ] && [ ! -L "$1" ] && hash_matches "$2" "$3"; then
        MOVE_OUTCOME=moved
    elif hash_matches "$1" "$3" && [ ! -e "$2" ] && [ ! -L "$2" ]; then
        MOVE_OUTCOME=not-moved
    fi
}
verify_live() {
    live_seen=' '
    while read -r expected live_name; do
        case "$live_name" in chirpstack.sqlite|chirpstack.sqlite-wal|chirpstack.sqlite-shm|chirpstack.sqlite-journal|chirpstack.redis) ;; *) return 1 ;; esac
        live_path "$live_name"
        [ -f "$LIVE" ] && [ ! -L "$LIVE" ] || return 1
        hash_file "$LIVE" || return 1
        [ "$HASH" = "$expected" ] || return 1
        live_seen="$live_seen$live_name "
    done < "$1"
    for live_name in $FILES; do
        case "$live_seen" in *" $live_name "*) continue ;; esac
        live_path "$live_name"
        [ ! -e "$LIVE" ] && [ ! -L "$LIVE" ] || return 1
    done
    return 0
}
restartable_live() {
    [ -s "$ROOT/srv/chirpstack/chirpstack.sqlite" ] && [ -s "$REDIS" ]
}
rollback() {
    # A failed start may have spawned a writer. Prove both stopped again before
    # moving anything back; preserve the originals if that cannot be proved.
    rollback_result=0
    stop_service chirpstack || rollback_result=1
    stop_service redis || rollback_result=1
    [ "$rollback_result" -eq 0 ] || return 1
    for rollback_name in $MOVED; do
        live_path "$rollback_name"
        recovery="$LIVE.pre-restore-$STAMP"
        pending="$recovery.pending"
        original_hash "$rollback_name" || return 1
        # Keep every original until recovery is verified. Stage a checked copy
        # beside the live path, then atomically replace it; never unlink the
        # replacement before the rename succeeds.
        if [ ! -e "$pending" ] && [ ! -L "$pending" ] && copy_checked "$recovery" "$pending"; then
            if ! mv "$pending" "$LIVE"; then
                classify_live_move "$pending" "$LIVE" "$ORIGINAL_HASH"
                case "$MOVE_OUTCOME" in
                    moved) ;; # The checked original is back despite the status.
                    not-moved) rollback_result=1 ;;
                    unclear) ERROR="$ERROR; move outcome unclear: $pending -> $LIVE"; return 1 ;;
                esac
            fi
        else
            rollback_result=1
        fi
        if [ -e "$pending" ]; then rm -f "$pending" || rollback_result=1; fi
    done
    if [ "$RESTORING" = 1 ]; then
        # Remove only paths absent from the original set, including sidecars
        # created by a failed start. Originals and their recovery copies stay.
        for rollback_name in $FILES; do
            case " $ORIGINAL_FILES " in *" $rollback_name "*) continue ;; esac
            live_path "$rollback_name"
            rm -f "$LIVE" || rollback_result=1
        done
    fi
    verify_live "$ORIGINAL_MANIFEST" || rollback_result=1
    return "$rollback_result"
}
restartable_originals() {
    for restart_name in chirpstack.sqlite chirpstack.redis; do
        case " $ORIGINAL_FILES " in *" $restart_name "*) ;; *) return 1 ;; esac
        live_path "$restart_name"
        if [ -e "$LIVE.pre-restore-$STAMP" ]; then
            [ -s "$LIVE.pre-restore-$STAMP" ] || return 1
        else
            [ -s "$LIVE" ] || return 1
        fi
    done
}
quote_path() {
    # Single-quote operator commands, including a test root containing quotes.
    quote_rest=$1
    QUOTED="'"
    while :; do
        case "$quote_rest" in
            *"'"*) QUOTED="$QUOTED${quote_rest%%\'*}'\''"; quote_rest=${quote_rest#*\'} ;;
            *) QUOTED="$QUOTED$quote_rest'"; break ;;
        esac
    done
}
report_recovery() {
    log "ERROR: ROLLBACK INCOMPLETE: services will not be started; recovery lock retained at $LOCK" >&2
    for recovery_name in $FILES; do
        live_path "$recovery_name"
        live_state=absent
        if [ -e "$LIVE" ]; then live_state=present; fi
        recovery="$LIVE.pre-restore-$STAMP"
        recovery_state=absent
        if [ -e "$recovery" ]; then recovery_state=present; fi
        log "RECOVERY: $recovery_name: live $LIVE ($live_state); original $recovery ($recovery_state)" >&2
        if [ -e "$recovery.pending" ]; then log "RECOVERY: pending copy $recovery.pending" >&2; fi
    done
    log "RECOVERY: recovery snapshot retained at $TMP" >&2
    log 'BEGIN RECOVERY COMMANDS' >&2
    log '(' >&2
    quote_path "$LOCK"; log "recovery_lock=$QUOTED" >&2
    quote_path "$STAMP"; log "recovery_token=$QUOTED" >&2
    log "recovery_stop_chirpstack=$STOP_CHIRPSTACK" >&2
    log "recovery_stop_redis=$STOP_REDIS" >&2
    quote_path "$ORIGINAL_MANIFEST"; log "recovery_manifest=$QUOTED" >&2
    cat >&2 <<'RECOVERY_START'
# flock is enabled by the shipped BusyBox defaults. Keep this guard inode:
# unlinking it could give concurrent executions different process locks.
# Its kernel ownership ends when the recovery process and its children exit.
recovery_guard="${recovery_lock%/*}/.chirpstack-recovery.guard"
recovery_claim="$recovery_lock.recovery-$recovery_token"
[ -d "$recovery_lock" ] && [ "$(cat "$recovery_lock/recovery" 2>/dev/null)" = "$recovery_token" ] || {
    echo 'ERROR: recovery already completed or another maintenance owner holds the lock' >&2
    exit 1
}
command -v flock >/dev/null 2>&1 || { echo 'ERROR: recovery requires BusyBox flock; lock retained' >&2; exit 1; }
[ ! -L "$recovery_guard" ] && { [ ! -e "$recovery_guard" ] || [ -f "$recovery_guard" ]; } || exit 1
# Ignore signals across external acquisition commands and owner bookkeeping.
trap '' HUP INT TERM
exec 9>>"$recovery_guard" || exit 1
flock -n 9 || { echo 'ERROR: recovery execution already claimed' >&2; exit 1; }
# Holding flock proves no live recovery owner can be using an empty claim.
# A killed process leaves that directory behind; clear only an empty real dir.
if ! mkdir "$recovery_claim" 2>/dev/null; then
    [ -d "$recovery_claim" ] && [ ! -L "$recovery_claim" ] && rmdir "$recovery_claim" && mkdir "$recovery_claim" || {
        echo 'ERROR: recovery claim contains retained files; inspect it, do not delete it' >&2
        exit 1
    }
    echo 'RECOVERY: cleared abandoned empty execution claim under exclusive process lock' >&2
fi
recovery_owned=0
recovery_finish() {
    recovery_result=$?
    trap - 0
    trap '' HUP INT TERM
    if [ "$recovery_owned" = 1 ] && [ "$recovery_result" -ne 0 ] &&
       [ "$(cat "$recovery_lock/recovery" 2>/dev/null)" = "$recovery_token" ]; then
        [ "$recovery_stop_chirpstack" = 0 ] || service chirpstack stop
        [ "$recovery_stop_redis" = 0 ] || service redis stop
    fi
    rmdir "$recovery_claim" || recovery_result=1
    exit "$recovery_result"
}
trap recovery_finish 0
# A delayed contender must recheck after it owns the process lock and claim.
[ -d "$recovery_lock" ] && [ "$(cat "$recovery_lock/recovery" 2>/dev/null)" = "$recovery_token" ] || exit 1
recovery_owned=1
trap 'exit 1' HUP INT TERM
recovery_fail() { echo "ERROR: recovery $*; lock retained" >&2; exit 1; }
recovery_hash_matches() {
    [ -f "$1" ] && [ ! -L "$1" ] || return 1
    printf '%s  %s\n' "$2" "$1" | sha256sum -c - >/dev/null 2>&1
}
recovery_move() {
    if mv -f "$1" "$2"; then return 0; fi
    if [ ! -e "$1" ] && [ ! -L "$1" ] && recovery_hash_matches "$2" "$3"; then return 0; fi
    if recovery_hash_matches "$1" "$3" && [ ! -e "$2" ] && [ ! -L "$2" ]; then
        recovery_fail "rename did not take effect: $1 -> $2"
    fi
    recovery_fail "move outcome unclear: $1 -> $2"
}

[ "$recovery_stop_chirpstack" = 0 ] || service chirpstack stop || recovery_fail 'stop ChirpStack'
[ "$recovery_stop_redis" = 0 ] || service redis stop || recovery_fail 'stop Redis'
RECOVERY_START
    if [ "$PROBE" = pidof ]; then
        log 'recovery_running() { pidof "$1" >/dev/null 2>&1; }' >&2
    else
        log 'recovery_running() { pgrep -x "$1" >/dev/null 2>&1; }' >&2
    fi
    cat >&2 <<'RECOVERY_STOP'
for recovery_process in chirpstack redis-server; do
    case "$recovery_process" in
        chirpstack) [ "$recovery_stop_chirpstack" = 1 ] || continue ;;
        redis-server) [ "$recovery_stop_redis" = 1 ] || continue ;;
    esac
    recovery_wait=0
    while :; do
        recovery_running "$recovery_process"
        recovery_probe=$?
        case "$recovery_probe" in 1) break ;; 0) ;; *) recovery_fail 'process probe failed' ;; esac
        [ "$recovery_wait" -lt 30 ] || recovery_fail "$recovery_process still running"
        sleep 1 || recovery_fail 'stop wait'
        recovery_wait=$((recovery_wait + 1))
    done
done
RECOVERY_STOP
    if [ "$ORIGINALS_RECORDED" = 1 ]; then
        while read -r expected recovery_name; do
            case " $MOVED $UNCLEAR_MOVES " in *" $recovery_name "*) ;; *) continue ;; esac
            live_path "$recovery_name"
            quote_path "$LIVE.pre-restore-$STAMP"; recovery_from=$QUOTED
            quote_path "$LIVE.pre-restore-$STAMP.pending"; recovery_pending=$QUOTED
            quote_path "$LIVE"; recovery_to=$QUOTED
            log "if recovery_hash_matches $recovery_from '$expected'; then" >&2
            log "  [ ! -L $recovery_pending ] || recovery_fail 'pending path is a symlink'" >&2
            log "  cp -p $recovery_from $recovery_pending || recovery_fail 'copy $recovery_name'" >&2
            log "  recovery_hash_matches $recovery_pending '$expected' || recovery_fail 'hash $recovery_name'" >&2
            log "  recovery_move $recovery_pending $recovery_to '$expected'" >&2
            log "elif ! recovery_hash_matches $recovery_to '$expected'; then" >&2
            log "  recovery_fail 'no verified original for $recovery_name; inspect recovery paths'" >&2
            log 'fi' >&2
        done < "$ORIGINAL_MANIFEST"
        for recovery_name in $FILES; do
            case " $ORIGINAL_FILES " in *" $recovery_name "*) continue ;; esac
            live_path "$recovery_name"; quote_path "$LIVE"
            if [ -n "$MOVED$UNCLEAR_MOVES" ] || [ "$RESTORING" = 1 ]; then
                log "rm -f $QUOTED || recovery_fail 'remove originally absent $recovery_name'" >&2
            fi
            log "[ ! -e $QUOTED ] && [ ! -L $QUOTED ] || recovery_fail 'verify absent $recovery_name'" >&2
        done
        while read -r expected recovery_name; do
            live_path "$recovery_name"; quote_path "$LIVE"
            log "printf '%s  %s\n' '$expected' $QUOTED | sha256sum -c - || recovery_fail 'verify original $recovery_name'" >&2
        done < "$ORIGINAL_MANIFEST"
        done_recovery_inventory=1
    elif [ "$ORIGINAL_INVENTORY" = 1 ] && [ -z "$MOVED$UNCLEAR_MOVES" ] && [ "$RESTORING" = 0 ]; then
        # No live mutation occurred. Complete only the missing hashes, under
        # the same generation lock, before verifying or restarting anything.
        cat >&2 <<'RECOVERY_INVENTORY'
recovery_record_unmoved() {
    recovery_expected=
    if [ -f "$recovery_manifest" ]; then
        while read -r recovery_hash recovery_name; do
            if [ "$recovery_name" = "$2" ]; then recovery_expected=$recovery_hash; break; fi
        done < "$recovery_manifest"
    fi
    if [ -z "$recovery_expected" ]; then
        [ -f "$1" ] && [ ! -L "$1" ] || recovery_fail 'unmoved original is not a regular file'
        recovery_sum=$(sha256sum "$1") || recovery_fail 'complete unmoved original hash'
        recovery_expected=${recovery_sum%% *}
        [ "${#recovery_expected}" = 64 ] || recovery_fail 'invalid original hash'
        case "$recovery_expected" in *[!0-9a-f]*) recovery_fail 'invalid original hash' ;; esac
        printf '%s  %s\n' "$recovery_expected" "$2" >> "$recovery_manifest" || recovery_fail 'record unmoved original hash'
    fi
    recovery_hash_matches "$1" "$recovery_expected" || recovery_fail 'verify unmoved original'
}
RECOVERY_INVENTORY
        for recovery_name in $FILES; do
            live_path "$recovery_name"; quote_path "$LIVE"
            case " $ORIGINAL_FILES " in
                *" $recovery_name "*) log "recovery_record_unmoved $QUOTED '$recovery_name'" >&2 ;;
                *) log "[ ! -e $QUOTED ] && [ ! -L $QUOTED ] || recovery_fail 'verify absent $recovery_name'" >&2 ;;
            esac
        done
        done_recovery_inventory=1
    else
        log "recovery_fail 'original inventory unavailable; inspect retained snapshot and live paths'" >&2
        done_recovery_inventory=0
    fi
    # A verified original inventory may intentionally lack required live files.
    # In that case unlock with services stopped so restore can be retried.
    if [ "$done_recovery_inventory" = 0 ] || restartable_originals; then
        quote_path "$ROOT/srv/chirpstack/chirpstack.sqlite"; log "test -s $QUOTED || recovery_fail 'missing SQLite main file'" >&2
        quote_path "$REDIS"; log "test -s $QUOTED || recovery_fail 'missing Redis dump'" >&2
        cat >&2 <<'RECOVERY_END'
[ "$recovery_stop_redis" = 0 ] || service redis start || recovery_fail 'restart Redis'
[ "$recovery_stop_chirpstack" = 0 ] || service chirpstack start || recovery_fail 'restart ChirpStack'
recovery_wait=0
while :; do
    recovery_redis=0
    recovery_chirpstack=0
    if [ "$recovery_stop_redis" = 1 ]; then recovery_running redis-server; recovery_redis=$?; fi
    if [ "$recovery_stop_chirpstack" = 1 ]; then recovery_running chirpstack; recovery_chirpstack=$?; fi
    [ "$recovery_redis$recovery_chirpstack" != 00 ] || break
    case "$recovery_redis:$recovery_chirpstack" in 0:1|1:0|1:1) ;; *) recovery_fail 'restart probe failed' ;; esac
    [ "$recovery_wait" -lt 30 ] || recovery_fail 'restart services not running together'
    sleep 1 || recovery_fail 'restart wait'
    recovery_wait=$((recovery_wait + 1))
done
RECOVERY_END
    else
        log "echo 'RECOVERY: original inventory verified; services remain stopped; retry restore.sh'" >&2
    fi
    quote_path "$TMP"; log "rm -rf $QUOTED || recovery_fail 'cleanup verified recovery snapshot'" >&2
    cat >&2 <<'RECOVERY_UNLOCK'
trap '' HUP INT TERM
# Rename the owned lock into the claim. Its token stays intact until the
# maintenance path is released; failure cleanup never rewrites a newer lock.
if ! mv "$recovery_lock" "$recovery_claim/maintenance"; then
    [ "$(cat "$recovery_claim/maintenance/recovery" 2>/dev/null)" = "$recovery_token" ] || recovery_fail 'release lock after restart'
fi
recovery_owned=0
rm -f "$recovery_claim/maintenance/recovery" || recovery_fail 'clear completed recovery token'
rmdir "$recovery_claim/maintenance" || recovery_fail 'cleanup completed maintenance lock'
)
RECOVERY_UNLOCK
    log 'END RECOVERY COMMANDS' >&2
}
retain_originals() {
    for retained_name in $FILES; do
        live_path "$retained_name"
        for retained_path in "$LIVE.pre-restore-"*; do
            [ -e "$retained_path" ] || continue
            if [ "$retained_path" = "$LIVE.pre-restore-$STAMP" ]; then
                log "RETAINED: $retained_path"
                continue
            fi
            retained_generation=${retained_path#"$LIVE.pre-restore-"}
            case "$retained_generation" in
                20??????T??????Z-*) retained_pid=${retained_generation#*-}; case "$retained_pid" in ''|*[!0-9]*) continue ;; esac ;;
                *) continue ;;
            esac
            [ -f "$retained_path" ] && [ ! -L "$retained_path" ] || return 1
            rm -f "$retained_path" || return 1
        done
    done
}
archive_legacy() {
    for legacy_name in $FILES; do
        if [ -e "$BASE/$legacy_name" ] || [ -L "$BASE/$legacy_name" ]; then
            [ -f "$BASE/$legacy_name" ] && [ ! -L "$BASE/$legacy_name" ] || return 1
            if [ -z "$LEGACY_ARCHIVE" ]; then
                LEGACY_ARCHIVE=$(mktemp -d "$BASE/chirpstack-legacy-XXXXXX") || return 1
                chmod 700 "$LEGACY_ARCHIVE" || return 1
            fi
            mv "$BASE/$legacy_name" "$LEGACY_ARCHIVE/$legacy_name" || return 1
        fi
    done
}
report_error() {
    state='not running'
    if [ -n "$PROBE" ] && process_running chirpstack; then state=running; fi
    log "ERROR: $ERROR; ChirpStack $state" >&2
}
publication_from_filesystem() {
    # Flags alone cannot distinguish a failed mv from a completed rename whose
    # caller was interrupted (or whose command reported failure after rename).
    PUBLISH_PROVEN_ABSENT=0
    if [ ! -e "$PUBLISH_STAGE" ] && [ ! -L "$PUBLISH_STAGE" ] &&
       [ -d "$SET" ] && [ ! -L "$SET" ] &&
       [ -f "$SET/MANIFEST.sha256" ] && [ ! -L "$SET/MANIFEST.sha256" ] &&
       hash_file "$SET/MANIFEST.sha256" && [ "$HASH" = "$PUBLISH_MANIFEST_HASH" ]; then
        PUBLISHED=1
        return 0
    fi
    # The original staging directory still being intact proves its rename did
    # not commit. An absent destination also proves the new set is not in place.
    if { [ -d "$PUBLISH_STAGE" ] && [ ! -L "$PUBLISH_STAGE" ] &&
         hash_file "$PUBLISH_STAGE/MANIFEST.sha256" && [ "$HASH" = "$PUBLISH_MANIFEST_HASH" ]; } ||
       { [ ! -e "$SET" ] && [ ! -L "$SET" ]; }; then
        PUBLISHED=0
        PUBLISH_PROVEN_ABSENT=1
        return 0
    fi
    return 1
}
finish() {
    result=$?
    trap - 0
    trap '' HUP INT TERM
    # A refused contender owns no service state and must not disturb the owner.
    if [ "$LOCKED" != 1 ]; then report_error; exit "$result"; fi
    if [ -n "$PUBLISH_STAGE" ]; then
        publication_from_filesystem || { ERROR="$ERROR; cannot prove publication outcome; legacy files remain archived at $LEGACY_ARCHIVE"; result=1; }
    fi
    if [ "$PUBLISHING" = 1 ] && [ ! -e "$SET" ] && [ -d "$PREV" ]; then
        mv "$PREV" "$SET" || { ERROR="$ERROR; previous set remains at $PREV"; result=1; }
    fi
    if [ "$PUBLISHED" = 0 ] && [ "$PUBLISH_PROVEN_ABSENT" = 1 ] && [ -n "$LEGACY_ARCHIVE" ]; then
        for legacy_name in $FILES; do
            [ -e "$LEGACY_ARCHIVE/$legacy_name" ] || [ -L "$LEGACY_ARCHIVE/$legacy_name" ] || continue
            mv "$LEGACY_ARCHIVE/$legacy_name" "$BASE/$legacy_name" || { ERROR="$ERROR; legacy copy retained at $LEGACY_ARCHIVE/$legacy_name"; result=1; }
        done
        rmdir "$LEGACY_ARCHIVE" || result=1
    fi
    if [ "$result" -eq 0 ] && [ "$RESTORING" = 1 ]; then
        if ! verify_live "$TMP/MANIFEST.sha256" || ! restartable_live; then ERROR='verify: replacement live set is incomplete'; result=1; fi
    fi
    if [ "$result" -eq 0 ]; then
        if ! start_services; then ERROR='restart: service start failed'; result=1; fi
    fi
    if [ "$result" -ne 0 ] && [ "$RECOVERY_INCOMPLETE" = 1 ]; then
        report_recovery
    elif [ "$result" -ne 0 ] && { [ -n "$MOVED" ] || [ "$RESTORING" = 1 ]; }; then
        if rollback; then
            ROLLED_BACK=1
            log 'ROLLED BACK: original SQLite files and Redis dump restored'
        else
            RECOVERY_INCOMPLETE=1
            ERROR="ROLLBACK INCOMPLETE: $ERROR"
            report_recovery
        fi
    fi
    if [ "$result" -ne 0 ] && [ "$RECOVERY_INCOMPLETE" = 0 ] && [ "$STOP_CHIRPSTACK$STOP_REDIS" != 00 ]; then
        # Every failed run must verify the original inventory before startup,
        # including failures before the first move or during hash recording.
        # Completing an unfinished record is read-only and only permitted when
        # no live mutation occurred; known hashes are checked, never replaced.
        if [ "$ORIGINALS_RECORDED" != 1 ] && [ -z "$MOVED$UNCLEAR_MOVES" ] && [ "$RESTORING" = 0 ]; then
            record_originals || { ERROR="$ERROR; original inventory unverified"; RECOVERY_INCOMPLETE=1; }
        fi
        if [ "$ORIGINALS_RECORDED" != 1 ] || ! verify_live "$ORIGINAL_MANIFEST"; then
            RECOVERY_INCOMPLETE=1
            ERROR="$ERROR; original live set unverified"
            report_recovery
        elif ! restartable_live; then
            log 'RECOVERY: original inventory verified; services remain stopped; retry restore.sh'
        elif ! start_services; then
            ERROR="$ERROR; recovery service start failed"
            RECOVERY_INCOMPLETE=1
            [ "$STOP_CHIRPSTACK" = 0 ] || stop_service chirpstack || ERROR="$ERROR; ChirpStack stop unverified"
            [ "$STOP_REDIS" = 0 ] || stop_service redis || ERROR="$ERROR; Redis stop unverified"
            report_recovery
        fi
    fi
    if [ "$result" -eq 0 ] && [ "$RESTORING" = 1 ]; then
        retain_originals || log 'WARNING: retention: restore completed; cannot prune older originals' >&2
    fi
    # Keep the lock, snapshots and every original if recovery needs an operator.
    if [ "$RECOVERY_INCOMPLETE" = 0 ]; then
        if [ -n "$CHECK" ]; then rm -rf "$CHECK" || result=1; fi
        if [ -n "$TMP" ]; then rm -rf "$TMP" || result=1; fi
        if [ -f "$LOCK/recovery" ]; then rm -f "$LOCK/recovery" || result=1; fi
        rmdir "$LOCK" || { ERROR="$ERROR; lock cleanup failed"; result=1; }
    fi
    if [ "$result" -eq 0 ]; then log "$SUCCESS"
    else report_error; fi
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
# Ignore signals in the shell AND mkdir child until ownership is recorded.
trap '' HUP INT TERM
if mkdir "$LOCK"; then LOCKED=1; else
    fail 'preflight: backup or restore already running (lock retained after uncatchable interruption)'
fi
trap 'fail "signal: interrupted"' HUP INT TERM
TMP=$(mktemp -d "$BASE/.chirpstack-stage.XXXXXX") || fail 'preflight: cannot create temporary set'
chmod 700 "$TMP" || fail 'preflight: cannot secure temporary set'
STAMP=$(date -u +%Y%m%dT%H%M%SZ) || fail 'preflight: cannot read UTC time'
STAMP="$STAMP-$$"
printf '%s\n' "$STAMP" > "$LOCK/recovery" || fail 'preflight: cannot record recovery ownership'
# Stop both before copying anything, so a failed stop never publishes a partial set.
stop_service chirpstack || fail 'stop: ChirpStack did not stop within 30 seconds or stop failed'
stop_service redis || fail 'stop: Redis did not stop within 30 seconds or stop failed'
for name in $FILES; do
    live_path "$name"
    case "$name" in
        chirpstack.sqlite|chirpstack.redis) [ -s "$LIVE" ] || fail "backup: missing or empty $LIVE" ;;
    esac
    if [ -e "$LIVE" ]; then
        [ -f "$LIVE" ] && [ ! -L "$LIVE" ] || fail "backup: not a regular file $LIVE"
        copy_checked "$LIVE" "$TMP/$name" || fail "copy: $LIVE"
    fi
done
integrity "$TMP" || fail 'integrity: copied SQLite database is not ok'
write_manifest || fail 'manifest: cannot write checksums'
validate_set "$TMP" || fail 'manifest: temporary set failed validation'
hash_file "$TMP/MANIFEST.sha256" || fail 'publish: cannot record staged manifest'
PUBLISH_MANIFEST_HASH=$HASH
PUBLISH_STAGE=$TMP
archive_legacy || fail 'archive: cannot retain legacy flat backups'
# Rename complete directories on the same filesystem. Keep the old set until
# publication succeeds; the EXIT trap restores it if the final rename fails.
if [ -e "$SET" ] || [ -L "$SET" ]; then
    [ -d "$SET" ] && [ ! -L "$SET" ] || fail 'publish: current set is not a directory'
    rm -rf "$PREV" || fail 'publish: cannot remove older previous set'
    PUBLISHING=1
    mv "$SET" "$PREV" || fail 'publish: cannot retain previous set'
fi
# Do not let a catchable signal split the final rename from its bookkeeping.
trap '' INT TERM HUP
if mv "$TMP" "$SET"; then
    PUBLISHED=1
    TMP=
    PUBLISHING=0
    publish_status=0
else
    publish_status=$?
fi
trap 'fail "signal: interrupted"' HUP INT TERM
[ "$publish_status" -eq 0 ] || fail 'publish: cannot rename complete temporary set'
SUCCESS="OK: backup $SET"
exit 0
