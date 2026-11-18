#!/bin/sh
# Standalone LuCI helper. Keep the shared safety functions identical in both scripts.
# Restore reports and keeps the newest pre-restore generation after verified
# success; older generations are pruned then. Incomplete recovery never prunes.
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
MOVED=
UNCLEAR_MOVES=
ORIGINAL_FILES=
ORIGINAL_MANIFEST=
RECOVERY_INCOMPLETE=0
RESTORING=0
PUBLISHING=0
PUBLISHED=0
PUBLISH_STAGE=
PUBLISH_MANIFEST_HASH=
PUBLISH_PROVEN_ABSENT=1
LEGACY_ARCHIVE=
ARCHIVED=
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
    ORIGINAL_MANIFEST="$TMP/ORIGINAL.sha256"
    : > "$ORIGINAL_MANIFEST" || return 1
    for original_name in $FILES; do
        live_path "$original_name"
        if [ -e "$LIVE" ]; then
            hash_file "$LIVE" || return 1
            printf '%s  %s\n' "$HASH" "$original_name" >> "$ORIGINAL_MANIFEST" || return 1
            ORIGINAL_FILES="$ORIGINAL_FILES $original_name"
        fi
    done
}
original_hash() {
    ORIGINAL_HASH=
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
    printf '%s\n' "$STAMP" > "$LOCK/recovery" || log 'ERROR: cannot record recovery ownership' >&2
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
    log "RECOVERY: validated replacement snapshot and original hashes retained at $TMP" >&2
    log 'BEGIN RECOVERY COMMANDS' >&2
    log '(' >&2
    quote_path "$LOCK"; log "recovery_lock=$QUOTED" >&2
    quote_path "$STAMP"; log "recovery_token=$QUOTED" >&2
    cat >&2 <<'RECOVERY_START'
[ -d "$recovery_lock" ] && [ "$(cat "$recovery_lock/recovery" 2>/dev/null)" = "$recovery_token" ] || {
    echo 'ERROR: recovery already completed or another maintenance owner holds the lock' >&2
    exit 1
}
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
trap 'recovery_result=$?; trap - 0; if [ "$recovery_result" -ne 0 ]; then printf "%s\n" "$recovery_token" > "$recovery_lock/recovery"; service chirpstack stop; service redis stop; fi; exit "$recovery_result"' 0
service chirpstack stop || recovery_fail 'stop ChirpStack'
service redis stop || recovery_fail 'stop Redis'
RECOVERY_START
    if [ "$PROBE" = pidof ]; then
        log 'recovery_running() { pidof "$1" >/dev/null 2>&1; }' >&2
    else
        log 'recovery_running() { pgrep -x "$1" >/dev/null 2>&1; }' >&2
    fi
    cat >&2 <<'RECOVERY_STOP'
for recovery_process in chirpstack redis-server; do
    recovery_running "$recovery_process"
    [ "$?" -eq 1 ] || recovery_fail 'processes still running or probe failed'
done
RECOVERY_STOP
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
        log "rm -f $QUOTED || recovery_fail 'remove originally absent $recovery_name'" >&2
    done
    while read -r expected recovery_name; do
        live_path "$recovery_name"; quote_path "$LIVE"
        log "printf '%s  %s\n' '$expected' $QUOTED | sha256sum -c - || recovery_fail 'verify original $recovery_name'" >&2
    done < "$ORIGINAL_MANIFEST"
    quote_path "$ROOT/srv/chirpstack/chirpstack.sqlite"; log "test -s $QUOTED || recovery_fail 'missing SQLite main file'" >&2
    quote_path "$REDIS"; log "test -s $QUOTED || recovery_fail 'missing Redis dump'" >&2
    cat >&2 <<'RECOVERY_END'
service redis start || recovery_fail 'restart Redis'
service chirpstack start || recovery_fail 'restart ChirpStack'
for recovery_process in redis-server chirpstack; do
    recovery_wait=0
    until recovery_running "$recovery_process"; do
        [ "$recovery_wait" -lt 30 ] || recovery_fail "restart $recovery_process not running"
        sleep 1 || recovery_fail 'restart wait'
        recovery_wait=$((recovery_wait + 1))
    done
done
RECOVERY_END
    quote_path "$TMP"; log "rm -rf $QUOTED || recovery_fail 'cleanup verified recovery snapshot'" >&2
    cat >&2 <<'RECOVERY_UNLOCK'
rm -f "$recovery_lock/recovery" || recovery_fail 'clear recovery ownership'
rmdir "$recovery_lock" || recovery_fail 'release lock after restart'
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
            ARCHIVED="$ARCHIVED $legacy_name"
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
        for legacy_name in $ARCHIVED; do
            mv "$LEGACY_ARCHIVE/$legacy_name" "$BASE/$legacy_name" || { ERROR="$ERROR; legacy copy retained at $LEGACY_ARCHIVE/$legacy_name"; result=1; }
        done
        rmdir "$LEGACY_ARCHIVE" || result=1
    fi
    if [ "$result" -eq 0 ] && [ "$RESTORING" = 1 ]; then
        if ! verify_live "$TMP/MANIFEST.sha256"; then ERROR='verify: replacement live set is incomplete'; result=1; fi
    fi
    if [ "$result" -eq 0 ]; then
        if ! start_services; then ERROR='restart: service start failed'; result=1; fi
    fi
    if [ "$result" -ne 0 ] && [ "$RECOVERY_INCOMPLETE" = 1 ]; then
        report_recovery
    elif [ "$result" -ne 0 ] && { [ -n "$MOVED" ] || [ "$RESTORING" = 1 ]; }; then
        if rollback; then log 'ROLLED BACK: original SQLite files and Redis dump restored'
        else
            RECOVERY_INCOMPLETE=1
            ERROR="ROLLBACK INCOMPLETE: $ERROR"
            report_recovery
        fi
    fi
    if [ "$result" -ne 0 ] && [ "$RECOVERY_INCOMPLETE" = 0 ]; then
        if ! start_services; then ERROR="$ERROR; service start failed"; fi
    fi
    if [ "$result" -eq 0 ] && [ "$RESTORING" = 1 ]; then
        retain_originals || { ERROR='retention: cannot prune older originals'; result=1; }
    fi
    # Keep the lock, snapshots and every original if recovery needs an operator.
    if [ "$RECOVERY_INCOMPLETE" = 0 ]; then
        if [ -n "$CHECK" ]; then rm -rf "$CHECK" || result=1; fi
        if [ -n "$TMP" ]; then rm -rf "$TMP" || result=1; fi
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
record_originals || fail 'preflight: cannot record stopped original hashes'
for name in $FILES; do
    live_path "$name"
    if [ -e "$LIVE" ]; then
        original_hash "$name" || fail "move: missing original hash for $name"
        # Ignore catchable signals over the rename and its outcome bookkeeping.
        trap '' HUP INT TERM
        if mv "$LIVE" "$LIVE.pre-restore-$STAMP"; then
            MOVED="$MOVED $name"
        else
            classify_live_move "$LIVE" "$LIVE.pre-restore-$STAMP" "$ORIGINAL_HASH"
            case "$MOVE_OUTCOME" in
                moved) MOVED="$MOVED $name" ;;
                not-moved) ;;
                unclear) UNCLEAR_MOVES="$UNCLEAR_MOVES $name"; RECOVERY_INCOMPLETE=1 ;;
            esac
            trap 'fail "signal: interrupted"' HUP INT TERM
            if [ "$RECOVERY_INCOMPLETE" = 1 ]; then fail "move outcome unclear: $name"; fi
            fail "move: cannot retain original $name (outcome $MOVE_OUTCOME)"
        fi
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
