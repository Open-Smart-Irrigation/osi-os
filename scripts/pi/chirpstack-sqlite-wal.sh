#!/bin/sh
# Run per gateway after operator review: sh chirpstack-sqlite-wal.sh --apply
# OSI_CS_ROOT prefixes filesystem paths for tests. Other OSI_CS_* overrides
# select the test service, sqlite module and API port; defaults are the Pi's.
set -u
ROOT=${OSI_CS_ROOT:-}
INIT="$ROOT/etc/init.d/chirpstack"
SERVICE=${OSI_CS_SERVICE:-$INIT}
BACKUP=
STOPPED=0
MODIFIED=0
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
// PR #670 feed files, commit 9c5e682a90cf89b8d23cf43aeee69199bdaecfc9.
const feedScripts = {
  "backup.sh": `#!/bin/sh

echo "SQLite database"
service chirpstack stop
cp /srv/chirpstack/chirpstack.sqlite /srv/backup/chirpstack.sqlite
# WAL journal: ChirpStack does not close its connections on stop, so a -wal
# file (and -shm) usually remains and holds committed data. Copy the sidecars
# with the database, and drop stale ones left by an earlier backup.
for ext in -wal -shm; do
	rm -f "/srv/backup/chirpstack.sqlite$ext"
	[ -e "/srv/chirpstack/chirpstack.sqlite$ext" ] && cp "/srv/chirpstack/chirpstack.sqlite$ext" "/srv/backup/chirpstack.sqlite$ext"
done
service chirpstack start

echo "Backup Redis database"
service redis stop
cp /srv/redis/dump.rdb /srv/backup/chirpstack.redis
service redis start
`,
  "restore.sh": `#!/bin/sh

echo "Restore SQLite database"
service chirpstack stop
# WAL journal: a stale -wal or -shm next to the restored file would be replayed
# onto it. Remove them, then restore the backup's own sidecars if it has any.
for ext in -wal -shm; do
	rm -f "/srv/chirpstack/chirpstack.sqlite$ext"
done
cp /srv/backup/chirpstack.sqlite /srv/chirpstack/chirpstack.sqlite
for ext in -wal -shm; do
	[ -e "/srv/backup/chirpstack.sqlite$ext" ] && cp "/srv/backup/chirpstack.sqlite$ext" "/srv/chirpstack/chirpstack.sqlite$ext"
done
service chirpstack start

echo "Restore Redis database"
service redis stop
cp /srv/backup/chirpstack.redis /srv/redis/dump.rdb
service redis start
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
  const pragmas = lines.filter((l) => /^\s*pragmas\s*=/.test(l));
  const wal = pragmas.length === 1 && lines[a + 1] === pragma;
  if (pragmas.length && !(allowWal && wal)) fail();
  return wal;
}
function copy(source, dest) {
  const s = fs.statSync(source);
  if (!s.isFile()) throw Error('not a regular file: ' + source);
  fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
  fs.chownSync(dest, s.uid, s.gid);
  fs.chmodSync(dest, s.mode & 0o7777);
  fs.utimesSync(dest, s.atime, s.mtime);
}
function publish(dest, content, metadata, validate) {
  const temp = dest + '.wal-' + process.pid;
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    fs.chownSync(temp, metadata.uid, metadata.gid);
    fs.chmodSync(temp, metadata.mode & 0o7777);
    if (validate) validate(temp);
    fs.renameSync(temp, dest);
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
async function sql(query) {
  const sqlite = require(process.env.OSI_CS_SQLITE_MODULE || at('/srv/node-red/node_modules/sqlite3'));
  if (sqlite.DatabaseSync) {
    const d = new sqlite.DatabaseSync(dbFile);
    try { return d.prepare(query).all(); } finally { d.close(); }
  }
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
    case 'running': {
      let running = false;
      for (const pid of fs.readdirSync(at('/proc')).filter((p) => /^\d+$/.test(p))) {
        try {
          if (fs.readFileSync(at('/proc/') + pid + '/comm', 'utf8').trim() === 'chirpstack') running = true;
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
      }
      console.log(running ? 'yes' : 'no'); break;
    }
    case 'header': console.log(header()); break;
    case 'init-state': console.log(shape(fs.readFileSync(init, 'utf8'), true) ? 'yes' : 'no'); break;
    case 'preflight': {
      if (require('child_process').spawnSync('sh', ['-n', init]).status !== 0) throw Error('init script shape not recognised; not modified');
      if (shape(fs.readFileSync(init, 'utf8'), true) && header() === 'WAL') { console.log('already'); return; }
      shape(fs.readFileSync(init, 'utf8'), false);
      header();
      require(process.env.OSI_CS_SQLITE_MODULE || at('/srv/node-red/node_modules/sqlite3'));
      let size = 0;
      for (const name of ['chirpstack.sqlite', 'chirpstack.sqlite-wal', 'chirpstack.sqlite-shm', 'chirpstack.sqlite-journal']) {
        if (fs.existsSync(files[name])) size += fs.statSync(files[name]).size;
      }
      console.log(Math.ceil(size * 2 / 1024));
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
    case 'restore-config': {
      const { present } = saved(arg);
      for (const name of ['chirpstack.init', 'backup.sh', 'restore.sh']) {
        if (present.has(name)) { const p = path.join(arg, name); publish(files[name], fs.readFileSync(p), fs.statSync(p)); }
        else if (fs.existsSync(files[name])) fs.unlinkSync(files[name]);
      }
      break;
    }
    case 'restore-db': {
      const { present } = saved(arg);
      for (const name of ['chirpstack.sqlite', 'chirpstack.sqlite-wal', 'chirpstack.sqlite-shm', 'chirpstack.sqlite-journal']) {
        if (present.has(name)) { const p = path.join(arg, name); publish(files[name], fs.readFileSync(p), fs.statSync(p)); }
        else if (fs.existsSync(files[name])) fs.unlinkSync(files[name]);
      }
      break;
    }
    case 'config': {
      const text = fs.readFileSync(at('/var/etc/chirpstack/chirpstack.toml'), 'utf8');
      if (!text.split('\n').some((line) => line.trim() === pragma.trim())) throw Error('generated configuration lacks pragmas');
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
    "$SERVICE" stop || return 1
    stop_deadline=$(( $(date +%s) + 30 ))
    process_state=$(cs_node running) || return 1
    while [ "$process_state" = yes ]; do
        [ "$(date +%s)" -lt "$stop_deadline" ] || return 1
        sleep 1 || return 1
        process_state=$(cs_node running) || return 1
    done
}
start_cs() {
    "$SERVICE" start || return 1
    start_deadline=$(( $(date +%s) + 60 ))
    while :; do
        if running && cs_node port >/dev/null 2>&1; then return 0; fi
        [ "$(date +%s)" -lt "$start_deadline" ] || return 1
        sleep 1 || return 1
    done
}
rollback_changed() {
    # Never restore an old database over one ChirpStack has converted and
    # possibly written to. An unreadable header is uncertain: try SQLite's
    # lossless DELETE conversion, and leave stopped if that cannot succeed.
    stop_cs || return 1
    cs_node restore-config "$BACKUP" || return 1
    current=$(cs_node header 2>/dev/null) || current=unknown
    if [ "$current" = DELETE ] && [ "$MODE" = --apply ]; then
        cs_node restore-db "$BACKUP" || return 1
    else
        cs_node delete || return 1
    fi
    start_cs || return 1
}
finish() {
    result=$?
    trap - 0 HUP INT TERM
    if [ "$result" -ne 0 ] && [ "$STOPPED" = 1 ]; then
        if [ "$MODIFIED" = 1 ]; then
            if rollback_changed; then log "ROLLED BACK: ChirpStack init, scripts and SQLite journal; backup $BACKUP" >&2
            else log "ERROR: rollback incomplete; keep backup $BACKUP and inspect ChirpStack before restarting" >&2; fi
        else
            start_cs || log 'ERROR: could not restart unchanged ChirpStack' >&2
        fi
    fi
    [ "$LOCKED" != 1 ] || rmdir "$LOCK" || result=1
    exit "$result"
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
    if [ "$init_state:$journal:$scripts_state:$process_state" = yes:WAL:yes:yes ]; then log 'OK: already WAL'; exit 0; fi
    log 'needs conversion'
    exit 3
fi

[ "$(id -u)" = 0 ] || die 'must run as root; not modified'
if [ "$MODE" = --apply ]; then
    required=$(cs_node preflight) || exit 1
    if [ "$required" = already ]; then log 'OK: already WAL'; exit 0; fi
    free=$(df -Pk "$ROOT/srv" | awk 'NR == 2 { print $4 }') || die 'could not read free space'
    case "$free" in ''|*[!0-9]*) die 'could not read free space' ;; esac
    [ "$free" -ge "$required" ] || die 'not enough free space on /srv (need twice the database and sidecars); not modified'
else
    cs_node validate-backup "$BACKUP" || exit 1
    cs_node header >/dev/null || exit 1
    node -e 'require(process.env.OSI_CS_SQLITE_MODULE || process.argv[1])' "$ROOT/srv/node-red/node_modules/sqlite3" || die 'sqlite3 module unavailable'
fi
log 'OK: preconditions checked'
# mkdir is atomic: a concurrent one-shot must never stop the same database.
mkdir -p "$ROOT/var/run" || die 'cannot create run directory'
mkdir "$LOCK" 2>/dev/null || die 'another WAL one-shot is running (or its lock remains); not modified'
LOCKED=1
trap finish 0
trap 'exit 1' HUP INT TERM
if [ "$MODE" = --apply ]; then
    BACKUP="$ROOT/srv/backup/chirpstack-wal-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$ROOT/srv/backup" || die 'cannot create backup parent'
    (umask 077; mkdir "$BACKUP") || die 'backup directory already exists or cannot be created'
    log "OK: backup directory $BACKUP"
fi
# Set before stop: even a failed stop must try to restart the service.
STOPPED=1
stop_cs || die 'ChirpStack did not stop within 30 seconds; restarting unchanged'
log 'OK: ChirpStack stopped'
if [ "$MODE" = --rollback ]; then
    MODIFIED=1
    cs_node restore-config "$BACKUP" && cs_node delete || die 'rollback failed'
    start_cs || die 'ChirpStack did not start after rollback'
    STOPPED=0
    log "OK: ChirpStack restored to DELETE journal; backup $BACKUP"
    exit 0
fi
cs_node backup "$BACKUP" && sync && cs_node manifest "$BACKUP" && sync || die 'backup or manifest failed'
log 'OK: stopped database, sidecars, init and helper scripts backed up with manifest'
cs_node integrity || die 'SQLite integrity check failed; restarting unchanged'
log 'OK: SQLite integrity check passed'
MODIFIED=1
cs_node insert || die 'init insertion failed'
log 'OK: pragma inserted after sqlite path; owner and mode preserved'
cs_node install || die 'WAL-aware backup/restore installation failed'
log 'OK: WAL-aware backup/restore scripts installed when /opt/chirpstack exists'
start_cs || die 'ChirpStack failed to start or API port 8080 unavailable'
log 'OK: ChirpStack running and API port reachable'
journal=$(cs_node header) || die 'cannot verify converted header'
[ "$journal" = WAL ] || die 'SQLite header did not switch to 02 02'
sleep 10 && running && cs_node config || die 'post-start health or generated pragma check failed'
log 'OK: header 02 02, ChirpStack still running after 10 seconds, generated pragmas verified'
STOPPED=0
log "OK: ChirpStack SQLite on WAL; backup $BACKUP"
