#!/bin/sh
# After copying this script to /tmp, use this on a flaky SSH link:
# setsid sh /tmp/chirpstack-sqlite-wal.sh --apply > /tmp/cs-wal.log 2>&1 < /dev/null &
# Run per gateway only after operator review.
# OSI_CS_ROOT prefixes filesystem paths for tests. Other OSI_CS_* overrides
# select test commands, the service, sqlite module and API port; defaults are the Pi's.
set -u
# A lost SSH output pipe must not bypass the EXIT recovery path.
trap '' PIPE
ID=${OSI_CS_ID:-id}
DATE=${OSI_CS_DATE:-date}
SLEEP=${OSI_CS_SLEEP:-sleep}
DF=${OSI_CS_DF:-df}
SYNC=${OSI_CS_SYNC:-sync}
ROOT=${OSI_CS_ROOT:-}
INIT="$ROOT/etc/init.d/chirpstack"
SERVICE=${OSI_CS_SERVICE:-$INIT}
BACKUP=
STOPPED=0
MODIFIED=0
RESTART_ONLY=0
SCRIPTS_ONLY=0
HELPERS_CHANGED=0
LOCKED=0
LOCK="$ROOT/var/run/chirpstack-sqlite-wal.lock"

log() { printf '%s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# One embedded helper keeps the streamed one-shot self-contained. Checks read
# header bytes without opening SQLite (even a read-only SQLite open can create
# WAL shared-memory files). SQLite is opened only with the service stopped.
cs_node() {
    node - "$ROOT" "$@" <<'CS_NODE'
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [root, op, arg] = process.argv.slice(2);
const at = (p) => root + p;
const init = at('/etc/init.d/chirpstack');
const dbFile = at('/srv/chirpstack/chirpstack.sqlite');
const anchor = '\t\tpath="/srv/chirpstack/chirpstack.sqlite"';
const pragma = '\t\tpragmas = ["busy_timeout = 5000", "journal_mode = WAL", "foreign_keys = ON"]';
// Hardened feed helpers; installation tests compare these bytes with the current feed.
const feedScripts = {
  "backup.sh": `#!/bin/sh
# Standalone LuCI helper. Keep the shared safety functions identical in both scripts.
# OSI_CS_ROOT prefixes filesystem paths for the isolated failure-injection tests.
set -u
umask 077
ROOT=\${OSI_CS_ROOT:-}
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
log() { printf '%s\\n' "$*"; }
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
    HASH=\${sum%% *}
    [ "\${#HASH}" -eq 64 ] || return 1
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
            printf '%s  %s\\n' "$HASH" "$manifest_name" >> "$TMP/MANIFEST.sha256" || return 1
        fi
    done
}
validate_set() {
    [ -f "$1/MANIFEST.sha256" ] && [ ! -L "$1/MANIFEST.sha256" ] || return 1
    seen=' '
    while IFS= read -r line || [ -n "$line" ]; do
        expected=\${line%%  *}
        name=\${line#*  }
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
        name=\${entry##*/}
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
# Rename complete directories on the same filesystem. Keep the old set until
# publication succeeds; the EXIT trap restores it if the final rename fails.
if [ -e "$SET" ] || [ -L "$SET" ]; then
    [ -d "$SET" ] && [ ! -L "$SET" ] || fail 'publish: current set is not a directory'
    rm -rf "$PREV" || fail 'publish: cannot remove older previous set'
    PUBLISHING=1
    mv "$SET" "$PREV" || fail 'publish: cannot retain previous set'
fi
mv "$TMP" "$SET" || fail 'publish: cannot rename complete temporary set'
TMP=
PUBLISHING=0
SUCCESS="OK: backup $SET"
exit 0
`,
  "restore.sh": `#!/bin/sh
# Standalone LuCI helper. Keep the shared safety functions identical in both scripts.
# OSI_CS_ROOT prefixes filesystem paths for the isolated failure-injection tests.
set -u
umask 077
ROOT=\${OSI_CS_ROOT:-}
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
log() { printf '%s\\n' "$*"; }
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
    HASH=\${sum%% *}
    [ "\${#HASH}" -eq 64 ] || return 1
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
            printf '%s  %s\\n' "$HASH" "$manifest_name" >> "$TMP/MANIFEST.sha256" || return 1
        fi
    done
}
validate_set() {
    [ -f "$1/MANIFEST.sha256" ] && [ ! -L "$1/MANIFEST.sha256" ] || return 1
    seen=' '
    while IFS= read -r line || [ -n "$line" ]; do
        expected=\${line%%  *}
        name=\${line#*  }
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
        name=\${entry##*/}
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
`
};
const files = {
  'chirpstack.sqlite': dbFile,
  'chirpstack.sqlite-wal': dbFile + '-wal',
  'chirpstack.sqlite-shm': dbFile + '-shm',
  'chirpstack.sqlite-journal': dbFile + '-journal',
  'chirpstack.init': init,
  'backup.sh': at('/opt/chirpstack/backup.sh'),
  'restore.sh': at('/opt/chirpstack/restore.sh'),
};
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function header() {
  const fd = fs.openSync(dbFile, 'r');
  try {
    const b = Buffer.alloc(100);
    if (fs.readSync(fd, b, 0, 100, 0) !== 100 || b.subarray(0, 16).toString() !== 'SQLite format 3\0') throw Error('invalid SQLite header');
    if (b[18] === 2 && b[19] === 2) return 'WAL';
    if (b[18] === 1 && b[19] === 1) return 'DELETE';
    throw Error('unrecognised SQLite journal header');
  } finally { fs.closeSync(fd); }
}
// Restrict recognition to the sqlite section of the configuration heredoc.
// Accept #670's commented multiline list and the one-shot's single line.
function configured(sqliteBlock) {
  const text = sqliteBlock.replace(/^\s*#.*$/gm, '');
  const match = /^\s*pragmas\s*=\s*\[([^\]]*)\]\s*$/m.exec(text);
  if (!match) return false;
  const values = match[1].split(',').map((v) => v.trim()).filter(Boolean);
  return values.includes('"busy_timeout = 5000"') && values.includes('"journal_mode = WAL"') &&
    values.every((v) => /^"[^"\r\n]*"$/.test(v));
}
function shape(text, allowWal) {
  const fail = () => { throw Error('init script shape not recognised; not modified'); };
  const lines = text.split('\n');
  const anchors = lines.map((l, i) => l === anchor ? i : -1).filter((i) => i >= 0);
  const configs = lines.map((l, i) => l === 'configuration() {' ? i : -1).filter((i) => i >= 0);
  if (anchors.length !== 1 || configs.length !== 1) fail();
  const a = anchors[0], start = configs[0], end = lines.indexOf('}', start);
  const here = lines.indexOf('\tcat >> /var/etc/$PACKAGE_NAME/$PACKAGE_NAME.toml <<- EOF', start);
  const eof = lines.indexOf('\tEOF', here + 1);
  if (!(start < here && here < a && a < eof && eof < end) || lines[a - 1] !== '\t\t[sqlite]') fail();
  const nextSection = lines.findIndex((l, i) => i > a && /^\s*\[/.test(l));
  const pragmas = lines.filter((l) => /^\s*pragmas\s*=/.test(l));
  const wal = pragmas.length === 1 && configured(lines.slice(a + 1, nextSection < 0 ? eof : Math.min(nextSection, eof)).join('\n'));
  if (pragmas.length && !(allowWal && wal)) fail();
  return wal;
}
function copy(source, dest) {
  const s = fs.statSync(source);
  if (!s.isFile()) throw Error('not a regular file: ' + source);
  const sourceHash = hash(source);
  fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
  if (hash(dest) !== sourceHash || hash(source) !== sourceHash) throw Error('backup copy mismatch: ' + source);
  fs.chownSync(dest, s.uid, s.gid);
  fs.chmodSync(dest, s.mode & 0o7777);
  fs.utimesSync(dest, s.atime, s.mtime);
}
function publish(dest, content, metadata, validate) {
  // Hidden name: even an uncatchable kill must not leave a boot init entry.
  const temp = path.join(path.dirname(dest), '.' + path.basename(dest) + '.wal-' + process.pid);
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    fs.chownSync(temp, metadata.uid, metadata.gid);
    fs.chmodSync(temp, metadata.mode & 0o7777);
    if (validate) validate(temp);
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, dest);
    const dir = fs.openSync(path.dirname(dest), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function saved(dir) {
  const entries = fs.readFileSync(path.join(dir, 'MANIFEST.txt'), 'utf8').trim().split('\n');
  const present = new Set();
  for (const line of entries) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || !(match[2] in files || match[2] === 'ABSENT.txt') || present.has(match[2])) throw Error('invalid backup manifest');
    present.add(match[2]);
    const p = path.join(dir, match[2]);
    if (fs.lstatSync(p).isSymbolicLink() || hash(p) !== match[1]) throw Error('backup manifest mismatch: ' + match[2]);
  }
  if (!present.has('ABSENT.txt') || !present.has('chirpstack.sqlite') || !present.has('chirpstack.init')) throw Error('incomplete backup manifest');
  const absent = new Set(fs.readFileSync(path.join(dir, 'ABSENT.txt'), 'utf8').split('\n').filter(Boolean));
  for (const name of absent) if (!(name in files) || present.has(name)) throw Error('invalid absent file record');
  for (const name of Object.keys(files)) if (!present.has(name) && !absent.has(name)) throw Error('incomplete backup: ' + name);
  return { present, absent };
}
function savedScripts(dir) {
  const present = new Set();
  const entries = fs.readFileSync(path.join(dir, 'MANIFEST.txt'), 'utf8').trim().split('\n');
  for (const line of entries) {
    const match = /^([a-f0-9]{64})  (ABSENT\.txt|backup\.sh|restore\.sh)$/.exec(line);
    if (!match || present.has(match[2])) throw Error('invalid helper backup manifest');
    const p = path.join(dir, match[2]);
    if (!fs.lstatSync(p).isFile() || hash(p) !== match[1]) throw Error('helper backup manifest mismatch: ' + match[2]);
    present.add(match[2]);
  }
  if (!present.has('ABSENT.txt')) throw Error('missing helper absence record');
  const absent = new Set(fs.readFileSync(path.join(dir, 'ABSENT.txt'), 'utf8').split('\n').filter(Boolean));
  for (const name of absent) {
    if (!['backup.sh', 'restore.sh'].includes(name) || present.has(name)) throw Error('invalid helper absence record');
  }
  for (const name of ['backup.sh', 'restore.sh']) {
    if (!present.has(name) && !absent.has(name)) throw Error('incomplete helper backup: ' + name);
  }
  return present;
}
async function sql(query) {
  const sqlite = require(process.env.OSI_CS_SQLITE_MODULE || at('/srv/node-red/node_modules/sqlite3'));
  // No CREATE: an absent database must never turn into an empty database.
  return new Promise((resolve, reject) => {
    const d = new sqlite.Database(dbFile, sqlite.OPEN_READWRITE, (err) => {
      if (err) { reject(err); return; }
      d.configure('busyTimeout', 5000);
      d.all(query, (error, rows) => d.close((closeError) => error || closeError ? reject(error || closeError) : resolve(rows)));
    });
  });
}
async function main() {
  switch (op) {
    case 'running':
    case 'identity': {
      const identities = [];
      for (const pid of fs.readdirSync(at('/proc')).filter((p) => /^\d+$/.test(p))) {
        try {
          const base = at('/proc/') + pid;
          if (fs.readlinkSync(base + '/exe') !== '/usr/bin/chirpstack') continue;
          const cmd = fs.readFileSync(base + '/cmdline', 'utf8').split('\0');
          if (cmd[0] !== '/usr/bin/chirpstack') continue;
          // starttime detects PID reuse as well as a procd respawn.
          const stat = fs.readFileSync(base + '/stat', 'utf8').split(') ')[1].split(' ');
          identities.push(pid + ':' + stat[19]);
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
      }
      identities.sort();
      console.log(op === 'identity' ? identities.join(',') : identities.length ? 'yes' : 'no'); break;
    }
    case 'scripts-needed': {
      // Only gateways with /opt/chirpstack carry these helpers.
      const needed = fs.existsSync(at('/opt/chirpstack')) && !Object.entries(feedScripts).every(([name, text]) => fs.existsSync(files[name]) && fs.readFileSync(files[name], 'utf8') === text);
      console.log(needed ? 'yes' : 'no'); break;
    }
    case 'backup-scripts': {
      const absent = [];
      for (const name of ['backup.sh', 'restore.sh']) {
        if (fs.existsSync(files[name])) copy(files[name], path.join(arg, name));
        else absent.push(name);
      }
      fs.writeFileSync(path.join(arg, 'ABSENT.txt'), absent.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      break;
    }
    case 'rollback-match': {
      // The current init must be the backup's init, or that init with exactly
      // the one-shot's pragma line inserted. Anything else was changed since.
      const before = fs.readFileSync(path.join(arg, 'chirpstack.init'), 'utf8');
      const current = fs.readFileSync(init, 'utf8');
      const converted = before.replace(anchor + '\n', anchor + '\n' + pragma + '\n');
      if (current !== before && current !== converted) throw Error('backup init does not match the current init; not modified');
      break;
    }
    case 'header': console.log(header()); break;
    case 'init-state': console.log(shape(fs.readFileSync(init, 'utf8'), true) ? 'yes' : 'no'); break;
    case 'preflight': {
      if (require('child_process').spawnSync('sh', ['-n', init]).status !== 0) throw Error('init script shape not recognised; not modified');
      const ready = shape(fs.readFileSync(init, 'utf8'), true);
      if (ready && header() === 'WAL') { console.log('already'); return; }
      header();
      require(process.env.OSI_CS_SQLITE_MODULE || at('/srv/node-red/node_modules/sqlite3'));
      let size = 0;
      for (const name of ['chirpstack.sqlite', 'chirpstack.sqlite-wal', 'chirpstack.sqlite-shm', 'chirpstack.sqlite-journal']) {
        if (fs.existsSync(files[name])) size += fs.statSync(files[name]).size;
      }
      console.log((ready ? 'restart:' : '') + Math.ceil(size * 2 / 1024));
      break;
    }
    case 'backup': {
      const absent = [];
      for (const [name, source] of Object.entries(files)) {
        if (fs.existsSync(source)) copy(source, path.join(arg, name));
        else absent.push(name);
      }
      fs.writeFileSync(path.join(arg, 'ABSENT.txt'), absent.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      break;
    }
    case 'manifest': {
      const names = fs.readdirSync(arg).sort();
      fs.writeFileSync(path.join(arg, 'MANIFEST.txt'), names.map((name) => `${hash(path.join(arg, name))}  ${name}\n`).join(''), { flag: 'wx', mode: 0o600 });
      saved(arg);
      break;
    }
    case 'manifest-scripts': {
      // Helper-only backup (already-converted gateway): not a --rollback directory.
      const names = fs.readdirSync(arg).sort();
      if (!names.every((name) => ['ABSENT.txt', 'backup.sh', 'restore.sh'].includes(name))) throw Error('unexpected file in helper backup');
      fs.writeFileSync(path.join(arg, 'MANIFEST.txt'), names.map((name) => `${hash(path.join(arg, name))}  ${name}\n`).join(''), { flag: 'wx', mode: 0o600 });
      break;
    }
    case 'validate-backup': saved(arg); break;
    case 'integrity': {
      const rows = await sql('PRAGMA integrity_check');
      if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw Error('integrity_check is not ok');
      break;
    }
    case 'delete': {
      const rows = await sql('PRAGMA journal_mode=DELETE');
      if (Object.values(rows[0])[0].toLowerCase() !== 'delete' || header() !== 'DELETE') throw Error('could not return database to DELETE journal');
      break;
    }
    case 'insert': {
      const text = fs.readFileSync(init, 'utf8'); shape(text, false);
      const next = text.replace(anchor + '\n', anchor + '\n' + pragma + '\n');
      shape(next, true);
      // <<- EOF strips tabs: prove the rendered sqlite block contains both
      // literal lines before atomically publishing the otherwise unchanged init.
      if (!next.split('\n').map((l) => l.replace(/^\t+/, '')).join('\n').includes('[sqlite]\n' + anchor.trim() + '\n' + pragma.trim() + '\n')) throw Error('sqlite heredoc did not render');
      publish(init, next, fs.statSync(init), (temp) => {
        if (!shape(fs.readFileSync(temp, 'utf8'), true)) throw Error('temporary init lacks pragmas');
        const check = require('child_process').spawnSync('sh', ['-n', temp]);
        if (check.status !== 0) throw Error('temporary init does not parse');
      });
      break;
    }
    case 'clean-temps': {
      for (const dest of [init, files['backup.sh'], files['restore.sh']]) {
        const dir = path.dirname(dest), prefix = '.' + path.basename(dest) + '.wal-';
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length))) fs.unlinkSync(path.join(dir, name));
        }
      }
      break;
    }
    case 'install': {
      if (fs.existsSync(at('/opt/chirpstack'))) {
        for (const [name, text] of Object.entries(feedScripts)) publish(files[name], text, { uid: process.getuid(), gid: process.getgid(), mode: 0o755 });
      }
      break;
    }
    case 'scripts-state': {
      const yes = Object.entries(feedScripts).every(([name, text]) => fs.existsSync(files[name]) && fs.readFileSync(files[name], 'utf8') === text);
      console.log(yes ? 'yes' : 'no'); break;
    }
    case 'restore-scripts': {
      // Helper-only recovery has no init/database backup and must not stop
      // ChirpStack or change its journal. Validate both originals first.
      const present = savedScripts(arg);
      const failed = [];
      for (const name of ['backup.sh', 'restore.sh']) {
        try {
          if (present.has(name)) { const p = path.join(arg, name); publish(files[name], fs.readFileSync(p), fs.statSync(p)); }
          else if (fs.existsSync(files[name])) fs.unlinkSync(files[name]);
          console.error('RESTORED: ' + name + (present.has(name) ? '' : ' (originally absent)'));
        } catch (error) {
          console.error('NOT RESTORED: ' + name + ': ' + error.message);
          failed.push(name);
        }
      }
      if (failed.length) throw Error('helper restoration failed: ' + failed.join(', '));
      break;
    }
    case 'restore-config': {
      let present;
      try { ({ present } = saved(arg)); }
      catch (error) { console.error('NOT RESTORED: chirpstack.init, backup.sh, restore.sh (backup validation failed)'); throw error; }
      const failed = [];
      for (const name of ['chirpstack.init', 'backup.sh', 'restore.sh']) {
        try {
          if (present.has(name)) { const p = path.join(arg, name); publish(files[name], fs.readFileSync(p), fs.statSync(p)); }
          else if (fs.existsSync(files[name])) fs.unlinkSync(files[name]);
          console.error('RESTORED: ' + name + (present.has(name) ? '' : ' (originally absent)'));
        } catch (error) {
          console.error('NOT RESTORED: ' + name + ': ' + error.message);
          failed.push(name);
        }
      }
      if (failed.length) throw Error('configuration restoration failed: ' + failed.join(', '));
      break;
    }
    case 'config': {
      const text = fs.readFileSync(at('/var/etc/chirpstack/chirpstack.toml'), 'utf8');
      const block = /(?:^|\n)\s*\[sqlite\]([^]*?)(?=\n\s*\[|$)/.exec(text);
      if (!block || !configured(block[1])) throw Error('generated configuration lacks pragmas');
      break;
    }
    case 'port': {
      await new Promise((resolve, reject) => {
        const socket = require('net').connect(Number(process.env.OSI_CS_API_PORT || 8080), '127.0.0.1');
        socket.setTimeout(1000);
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
        socket.once('timeout', () => { socket.destroy(); reject(Error('API port timeout')); });
      }); break;
    }
    default: throw Error('unknown helper operation');
  }
}
main().catch((error) => { console.error('ERROR: ' + error.message); process.exitCode = 1; });
CS_NODE
}

running() { [ "$(cs_node running)" = yes ]; }
stop_cs() {
    # procd can return nonzero for an already-stopped service. Trust /proc.
    "$SERVICE" stop || :
    stop_deadline=$(( $("$DATE" +%s) + 30 ))
    process_state=$(cs_node running) || return 1
    while [ "$process_state" = yes ]; do
        [ "$("$DATE" +%s)" -lt "$stop_deadline" ] || return 1
        "$SLEEP" 1 || return 1
        process_state=$(cs_node running) || return 1
    done
}
start_cs() {
    "$SERVICE" start || return 1
    start_deadline=$(( $("$DATE" +%s) + 60 ))
    while :; do
        if running && cs_node port >/dev/null 2>&1; then return 0; fi
        [ "$("$DATE" +%s)" -lt "$start_deadline" ] || return 1
        "$SLEEP" 1 || return 1
    done
}
rollback_changed() {
    rollback_result=0
    if stop_cs; then
        cs_node restore-config "$BACKUP" || rollback_result=1
        "$SYNC" || rollback_result=1
        current=$(cs_node header 2>/dev/null) || current=unknown
        case "$current" in
            WAL) if cs_node delete; then log 'RESTORED: SQLite DELETE journal (current data retained)' >&2
                 else log 'NOT RESTORED: SQLite DELETE journal' >&2; rollback_result=1; fi ;;
            DELETE) log 'RESTORED: SQLite already DELETE; database untouched' >&2 ;;
            *) log 'NOT RESTORED: unreadable SQLite header; database untouched' >&2; rollback_result=1 ;;
        esac
    else
        log 'NOT RESTORED: init, scripts and journal (ChirpStack did not stop)' >&2
        rollback_result=1
    fi
    # Always try, even if stop, validation, a file restore or SQLite failed.
    if start_cs; then log 'RESTORED: ChirpStack started' >&2
    else log 'NOT RESTORED: ChirpStack start failed' >&2; rollback_result=1; fi
    final_journal=$(cs_node header 2>/dev/null) || final_journal=unknown
    log "SQLite journal after restart: $final_journal" >&2
    log "Database backup is an operator-restore artefact only; never copied over live data: $BACKUP" >&2
    return "$rollback_result"
}
finish() {
    result=$?
    trap - 0
    # Cleanup must finish even if the terminal keeps sending signals.
    trap '' HUP INT TERM
    if [ "$result" -ne 0 ] && [ "$HELPERS_CHANGED" = 1 ]; then
        if cs_node restore-scripts "$BACKUP" && "$SYNC"; then
            log "ROLLED BACK: previous backup/restore helpers; backup $BACKUP" >&2
        else
            log "ERROR: helper rollback incomplete; see RESTORED/NOT RESTORED above; backup $BACKUP" >&2
        fi
    fi
    if [ "$result" -ne 0 ] && [ "$STOPPED" = 1 ]; then
        if [ "$MODIFIED" = 1 ]; then
            if rollback_changed; then log "ROLLED BACK: ChirpStack init, scripts and SQLite journal; backup $BACKUP" >&2
            else log "ERROR: rollback incomplete; see RESTORED/NOT RESTORED above; backup $BACKUP" >&2; fi
        else
            start_cs || log 'ERROR: could not restart unchanged ChirpStack' >&2
        fi
    fi
    if [ "$LOCKED" = 1 ]; then
        cs_node clean-temps || result=1
        rm -f "$LOCK/backup" || result=1
        rmdir "$LOCK" || result=1
    fi
    exit "$result"
}
refuse_lock() {
    if recovery_backup=$(cat "$LOCK/backup" 2>/dev/null) && [ -n "$recovery_backup" ]; then
        die "another WAL one-shot is running or its lock remains: $LOCK; backup $recovery_backup; after confirming no one-shot is running, remove $LOCK/backup and $LOCK, then run sh /tmp/chirpstack-sqlite-wal.sh --rollback $recovery_backup"
    fi
    # Never guess a backup: the newest directory may belong to an earlier run.
    die "another WAL one-shot is running or its lock remains: $LOCK; no backup directory was recorded; inspect $ROOT/srv/backup and the ChirpStack state by hand before removing $LOCK; not modified"
}

MODE=${1:---check}
case "$MODE" in
    --check|--apply) [ "$#" -le 1 ] || die 'usage: chirpstack-sqlite-wal.sh [--check|--apply|--rollback <backup-dir>]' ;;
    --rollback) [ "$#" = 2 ] || die '--rollback needs a backup directory'; BACKUP=$2 ;;
    *) die 'usage: chirpstack-sqlite-wal.sh [--check|--apply|--rollback <backup-dir>]' ;;
esac

command -v node >/dev/null 2>&1 || die 'Node unavailable; not modified'

if [ "$MODE" = --check ]; then
    init_state=$(cs_node init-state) || exit 1
    journal=$(cs_node header) || exit 1
    scripts_state=$(cs_node scripts-state) || exit 1
    process_state=$(cs_node running) || exit 1
    log "init pragmas: $init_state; journal: $journal; running: $process_state; backup/restore WAL-aware: $scripts_state"
    scripts_needed=$(cs_node scripts-needed) || exit 1
    if [ "$init_state:$journal:$scripts_needed" = yes:WAL:no ]; then log 'OK: already WAL'; exit 0; fi
    if [ "$init_state:$journal" = yes:WAL ]; then log 'needs WAL-aware backup/restore scripts'; exit 3; fi
    log 'needs conversion'
    exit 3
fi

[ "$("$ID" -u)" = 0 ] || die 'must run as root; not modified'
[ ! -d "$LOCK" ] || refuse_lock
if [ "$MODE" = --apply ]; then
    required=$(cs_node preflight) || exit 1
    if [ "$required" = already ]; then
        [ "$(cs_node scripts-needed)" = yes ] || { log 'OK: already WAL'; exit 0; }
        SCRIPTS_ONLY=1
    fi
    case "$required" in restart:*) RESTART_ONLY=1; required=${required#restart:} ;; esac
    if [ "$SCRIPTS_ONLY" = 0 ]; then
        free=$("$DF" -Pk "$ROOT/srv" | awk 'NR == 2 { print $4 }') || die 'could not read free space'
        case "$free" in ''|*[!0-9]*) die 'could not read free space' ;; esac
        [ "$free" -ge "$required" ] || die 'not enough free space on /srv (need twice the database and sidecars); not modified'
    fi
else
    cs_node validate-backup "$BACKUP" || exit 1
    cs_node rollback-match "$BACKUP" || exit 1
    cs_node header >/dev/null || exit 1
    node -e 'require(process.env.OSI_CS_SQLITE_MODULE || process.argv[1])' "$ROOT/srv/node-red/node_modules/sqlite3" || die 'sqlite3 module unavailable'
fi
log 'OK: preconditions checked'
# mkdir is atomic: a concurrent one-shot must never stop the same database.
mkdir -p "$ROOT/var/run" || die 'cannot create run directory'
mkdir "$LOCK" 2>/dev/null || refuse_lock
LOCKED=1
trap finish 0
trap 'exit 1' HUP INT TERM
if [ "$MODE" = --apply ]; then
    BACKUP="$ROOT/srv/backup/chirpstack-wal-$("$DATE" -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$ROOT/srv/backup" || die 'cannot create backup parent'
    (umask 077; mkdir "$BACKUP") || die 'backup directory already exists or cannot be created'
    log "OK: backup directory $BACKUP"
fi
printf '%s\n' "$BACKUP" > "$LOCK/backup" || die 'cannot record recovery backup'
if [ "$SCRIPTS_ONLY" = 1 ]; then
    # ChirpStack and its database are already converted; only the helpers are
    # stale, so ChirpStack keeps running and the database is not copied.
    cs_node backup-scripts "$BACKUP" && "$SYNC" && cs_node manifest-scripts "$BACKUP" && "$SYNC" || die 'helper script backup failed'
    HELPERS_CHANGED=1
    cs_node install && "$SYNC" || die 'WAL-aware backup/restore installation failed; previous helpers in '"$BACKUP"
    HELPERS_CHANGED=0
    log "OK: already WAL; WAL-aware backup/restore scripts installed; previous helpers in $BACKUP"
    exit 0
fi
# Set before stop: even a failed stop must try to restart the service.
STOPPED=1
stop_cs || die 'ChirpStack did not stop within 30 seconds; restarting unchanged'
log 'OK: ChirpStack stopped'
if [ "$MODE" = --rollback ]; then
    # This path already performs recovery; do not retry it in the EXIT trap.
    trap '' HUP INT TERM
    STOPPED=0
    rollback_changed || die 'rollback incomplete; see RESTORED/NOT RESTORED above'
    log "OK: ChirpStack configuration restored; journal $final_journal; backup $BACKUP"
    exit 0
fi
cs_node backup "$BACKUP" && "$SYNC" && cs_node manifest "$BACKUP" && "$SYNC" || die 'backup or manifest failed'
log 'OK: stopped database, sidecars, init and helper scripts backed up with manifest'
cs_node integrity || die 'SQLite integrity check failed; restarting unchanged'
log 'OK: SQLite integrity check passed'
MODIFIED=1
if [ "$RESTART_ONLY" = 0 ]; then
    cs_node insert && "$SYNC" || die 'init insertion failed'
    log 'OK: pragma inserted after sqlite path; owner and mode preserved'
    cs_node install && "$SYNC" || die 'WAL-aware backup/restore installation failed'
    log 'OK: WAL-aware backup/restore scripts installed when /opt/chirpstack exists'
else
    log 'OK: existing WAL pragmas retained; restarting ChirpStack to switch the header'
    cs_node install && "$SYNC" || die 'WAL-aware backup/restore installation failed'
    log 'OK: WAL-aware backup/restore scripts installed when /opt/chirpstack exists'
fi
start_cs || die 'ChirpStack failed to start or API port 8080 unavailable'
log 'OK: ChirpStack running and API port reachable'
journal=$(cs_node header) || die 'cannot verify converted header'
[ "$journal" = WAL ] || die 'SQLite header did not switch to 02 02'
daemon_identity=$(cs_node identity) || die 'cannot record ChirpStack process'
[ -n "$daemon_identity" ] || die 'ChirpStack process disappeared'
"$SLEEP" 10 && [ "$(cs_node identity)" = "$daemon_identity" ] && cs_node config || die 'post-start health or generated pragma check failed'
log 'OK: header 02 02, ChirpStack still running after 10 seconds, generated pragmas verified'
STOPPED=0
log "OK: ChirpStack SQLite on WAL; backup $BACKUP"
