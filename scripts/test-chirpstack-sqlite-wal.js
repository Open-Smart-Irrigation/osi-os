'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const repo = path.resolve(__dirname, '..');
const script = path.join(repo, 'scripts/pi/chirpstack-sqlite-wal.sh');
const feed = path.join(repo, 'feeds/chirpstack-openwrt-feed/chirpstack/chirpstack/files');
const fixtures = path.join(__dirname, 'fixtures/chirpstack-sqlite-wal');
const original = fs.readFileSync(path.join(fixtures, 'chirpstack.init.orig'), 'utf8');
const pragma = '\t\tpragmas = ["busy_timeout = 5000", "journal_mode = WAL", "foreign_keys = ON"]';
const converted = original.replace('\t\tpath="/srv/chirpstack/chirpstack.sqlite"\n', `$&${pragma}\n`);
const initVariants = [
  ['without log capture', original, fs.readFileSync(path.join(fixtures, 'chirpstack.init.no-log-capture.wal'), 'utf8')],
  ['with log capture', fs.readFileSync(path.join(fixtures, 'chirpstack.init.log-capture.orig'), 'utf8'),
    fs.readFileSync(path.join(fixtures, 'chirpstack.init.log-capture.wal'), 'utf8')],
];
const shellCommand = process.env.OSI_CS_TEST_SHELL || (spawnSync('busybox', ['sh', '-c', 'exit 0']).status === 0 ? 'busybox' : 'dash');
// Keep the test shell available when a refusal case intentionally empties PATH.
// If neither shell exists, retain the command so spawn fails loudly with ENOENT.
const shell = shellCommand.includes('/') ? path.resolve(shellCommand) :
  (process.env.PATH || '').split(path.delimiter).map((dir) => path.resolve(dir, shellCommand)).find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ENOTDIR') return false; throw error; }
  }) || shellCommand;
const shellArgs = shell.endsWith('busybox') ? ['sh'] : [];
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function gateway(t, init = original) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-cs-wal-'));
  const p = (name) => path.join(root, name);
  for (const dir of ['etc/init.d', 'srv/chirpstack', 'srv/backup', 'opt/chirpstack', 'var/etc/chirpstack', 'proc/1', 'bin']) fs.mkdirSync(p(dir), { recursive: true });
  fs.writeFileSync(p('etc/init.d/chirpstack'), init, { mode: 0o751 });
  fs.writeFileSync(p('opt/chirpstack/backup.sh'), '#!/bin/sh\necho old-backup\n', { mode: 0o750 });
  fs.writeFileSync(p('opt/chirpstack/restore.sh'), '#!/bin/sh\necho old-restore\n', { mode: 0o700 });
  const db = new DatabaseSync(p('srv/chirpstack/chirpstack.sqlite'));
  db.exec('CREATE TABLE uplinks (id INTEGER PRIMARY KEY); INSERT INTO uplinks VALUES (1)');
  db.close();
  fs.writeFileSync(p('running'), 'chirpstack\n');
  fs.symlinkSync('/usr/bin/chirpstack', p('proc/1/exe'));
  fs.writeFileSync(p('proc/1/cmdline'), '/usr/bin/chirpstack\0-c\0/var/etc/chirpstack\0');
  fs.writeFileSync(p('proc/1/stat'), '1 (chirpstack) S ' + '0 '.repeat(18) + '123');
  fs.symlinkSync(p('running'), p('proc/1/comm'));
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const exe = (name, content) => fs.writeFileSync(p(`bin/${name}`), `#!/bin/sh\n${content}\n`, { mode: 0o755 });
  exe('node', `if [ "\${TEST_BAD_PORT:-0}" = 1 ] && grep -q pragmas "$OSI_CS_ROOT/etc/init.d/chirpstack"; then export OSI_CS_API_PORT=0; fi
exec '${process.execPath}' --require "$OSI_CS_ROOT/faults.cjs" "$@"`);
  exe('id', 'echo "${TEST_UID:-0}"');
  exe('sync', ':');
  exe('sleep', '[ "$1" != 10 ] || [ "${TEST_LATE_DEATH:-0}" != 1 ] || rm -f "$OSI_CS_ROOT/running" "$OSI_CS_ROOT/proc/1/exe"');
  fs.appendFileSync(p('bin/sleep'), '[ "$1" != 10 ] || [ "${TEST_RESPAWN:-0}" != 1 ] || echo "1 (chirpstack) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 124" > "$OSI_CS_ROOT/proc/1/stat"\n');
  // Ten virtual seconds per deadline check keep failed health checks bounded
  // to six polls, including on hosts where spawning each helper is slow.
  exe('date', 'if [ "$1" = +%s ]; then n=$(cat "$OSI_CS_ROOT/clock" 2>/dev/null || echo 0); n=$((n + 10)); echo "$n" > "$OSI_CS_ROOT/clock"; echo "$n"; else exec /usr/bin/date "$@"; fi');
  exe('df', 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "test 100000 0 ${TEST_FREE_KB:-100000} 0% /srv"');
  fs.writeFileSync(p('service'), `#!/bin/sh
set -eu
case "$1" in
stop)
  echo stop >> "$OSI_CS_ROOT/service-calls"
  [ -f "$OSI_CS_ROOT/running" ] || exit 1
  if [ -n "\${TEST_STOP_SIGNAL:-}" ] && [ ! -f "$OSI_CS_ROOT/signalled" ]; then
    touch "$OSI_CS_ROOT/signalled"
    kill -"$TEST_STOP_SIGNAL" "$PPID"
  fi
  [ "\${TEST_STOP_STUCK:-0}" != 1 ] || exit 0
  rm -f "$OSI_CS_ROOT/running" "$OSI_CS_ROOT/proc/1/exe"
  if [ "\${TEST_PAUSE_STOP:-0}" = 1 ] && [ ! -f "$OSI_CS_ROOT/stop-paused" ]; then
    echo paused > "$OSI_CS_ROOT/stop-paused"
    while [ ! -f "$OSI_CS_ROOT/stop-resume" ]; do /usr/bin/sleep 0.01; done
  fi ;;
start)
  echo start >> "$OSI_CS_ROOT/service-calls"
  if grep -q pragmas "$OSI_CS_ROOT/etc/init.d/chirpstack"; then
    [ "\${TEST_START_FAIL:-0}" != 1 ] || exit 1
    node -e 'const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.env.OSI_CS_ROOT+"/srv/chirpstack/chirpstack.sqlite"); if (process.env.TEST_NO_WAL !== "1") d.exec("PRAGMA journal_mode=WAL"); d.exec("INSERT OR IGNORE INTO uplinks VALUES (2)"); d.close()'
    if [ "\${TEST_START_SIGNAL:-}" != "" ] && [ ! -f "$OSI_CS_ROOT/signalled" ]; then
      touch "$OSI_CS_ROOT/signalled"; kill -"$TEST_START_SIGNAL" "$PPID"
    fi
  fi
  sed "s|/var/etc/|$OSI_CS_ROOT/var/etc/|g" "$OSI_CS_ROOT/etc/init.d/chirpstack" > "$OSI_CS_ROOT/rendered-init"
  . "$OSI_CS_ROOT/rendered-init"
  config_load() { :; }
  config_foreach() { :; }
  configuration
  [ "\${TEST_BAD_CONFIG:-0}" != 1 ] || echo bad > "$OSI_CS_ROOT/var/etc/chirpstack/chirpstack.toml"
  echo chirpstack > "$OSI_CS_ROOT/running"
  ln -sf /usr/bin/chirpstack "$OSI_CS_ROOT/proc/1/exe" ;;
esac
`, { mode: 0o755 });
  // Exercise the same callback surface as the gateway, backed by node:sqlite
  // when the native addon is absent. The production helper has one SQL path.
  fs.writeFileSync(p('sqlite3-adapter.cjs'), `
const s = require(${JSON.stringify(path.join(__dirname, 'lib/sqlite3-node-adapter.js'))}).createSqlite3Adapter();
s.Database.prototype.configure = function(name, value) {
  if (name !== 'busyTimeout' || value !== 5000) throw Error('unexpected sqlite configuration');
  this.native.exec('PRAGMA busy_timeout=5000');
};
module.exports = s;
`);
  fs.writeFileSync(p('faults.cjs'), `
const fs = require('node:fs');
const op = process.argv[3];
if (process.env.TEST_SLOW_POLL === '1' && ['running', 'port'].includes(op)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
}
if (op === 'port' && process.env.TEST_BAD_PORT === '1' && process.env.OSI_CS_API_PORT === '0') {
  fs.appendFileSync(process.env.OSI_CS_ROOT + '/bad-port-polls', 'poll\\n');
}
const originalReadFile = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (process.env.TEST_BOUNDED_HASH === '1' && typeof file === 'string' && /chirpstack\\.sqlite(?:-(?:wal|shm|journal))?$/.test(file)) throw Error('database-sized read refused');
  return originalReadFile.call(this, file, ...args);
};
const originalRead = fs.readSync;
fs.readSync = function(fd, buffer, offset, length, position) {
  if (process.env.TEST_BOUNDED_HASH === '1' && length > 65536) throw Error('unbounded hash chunk');
  return originalRead.apply(this, arguments);
};
if (op === 'backup' && process.env.TEST_KILL_DURING_BACKUP === '1') { process.kill(process.ppid, 'SIGKILL'); process.exit(1); }
const originalRename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (op === 'install' && process.env.TEST_SECOND_HELPER_FAIL === '1' && to.endsWith('/restore.sh')) throw Error('injected second helper install failure');
  if (op === 'restore-config' && process.env.TEST_RESTORE_FAIL === '1' && to.endsWith('/backup.sh')) throw Error('injected backup.sh restore failure');
  const result = originalRename.apply(this, arguments);
  if (op === 'install' && process.env.TEST_KILL_AFTER_FIRST_HELPER === '1' && to.endsWith('/backup.sh')) { process.kill(process.ppid, 'SIGKILL'); process.exit(1); }
  return result;
};
const originalFsync = fs.fsyncSync;
fs.fsyncSync = function(fd) {
  if (op === 'insert' && process.env.TEST_FSYNC_FAIL === '1') throw Error('injected fsync failure');
  return originalFsync.apply(this, arguments);
};
const originalCopy = fs.copyFileSync;
fs.copyFileSync = function(from, to) {
  originalCopy.apply(this, arguments);
  if (op === 'backup' && process.env.TEST_BAD_COPY === '1') fs.appendFileSync(to, 'bad copy');
};
if (op === 'delete' && process.env.TEST_DELETE_FAIL === '1') throw Error('injected DELETE failure');
// An uncatchable kill of the one-shot between the init edit and the helper install.
if (op === 'install' && process.env.TEST_KILL_BEFORE_INSTALL === '1') { process.kill(process.ppid, 'SIGKILL'); process.exit(1); }
`);
  const env = { ...process.env, PATH: `${p('bin')}:${path.dirname(process.execPath)}:${process.env.PATH}`, OSI_CS_ROOT: root, OSI_CS_SQLITE_MODULE: process.env.OSI_CS_TEST_SQLITE_MODULE || p('sqlite3-adapter.cjs'), OSI_CS_ID: p('bin/id'), OSI_CS_DATE: p('bin/date'), OSI_CS_SLEEP: p('bin/sleep'), OSI_CS_DF: p('bin/df'), OSI_CS_SYNC: p('bin/sync'), OSI_CS_SERVICE: p('service'), OSI_CS_API_PORT: String(server.address().port), NODE_NO_WARNINGS: '1' };
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Static BusyBox ash prefers its applets over PATH, bypassing race and
  // process-probe stubs. Shell functions keep those same stubs observable.
  const invocation = (file, args = [], childEnv = env) => {
    const mocked = childEnv.PATH.split(path.delimiter).includes(p('bin')) ? fs.readdirSync(p('bin')) : [];
    const prelude = mocked.map(name => {
      assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
      const target = p(`bin/${name}`).replaceAll("'", "'\\''");
      return `${name}() { '${target}' "$@"; }`;
    }).join('\n');
    return [...shellArgs, '-c', `${prelude}\nfixture_script=$1; shift; . "$fixture_script"`, file, file, ...args];
  };
  const run = (args = [], extra = {}) => {
    const childEnv = { ...env, ...extra };
    return spawnSync(shell, invocation(script, args, childEnv), { env: childEnv, encoding: 'utf8', timeout: 20000 });
  };
  const state = () => Object.fromEntries(['etc/init.d/chirpstack', 'opt/chirpstack/backup.sh', 'opt/chirpstack/restore.sh', 'srv/chirpstack/chirpstack.sqlite'].map((f) => [f, [hash(p(f)), fs.statSync(p(f)).mtimeMs, fs.statSync(p(f)).mode]]));
  const journal = () => [...fs.readFileSync(p('srv/chirpstack/chirpstack.sqlite')).subarray(18, 20)];
  const backup = () => p(`srv/backup/${fs.readdirSync(p('srv/backup')).find(n => n.startsWith('chirpstack-wal-'))}`);
  return { root, p, run, state, journal, backup, env, invocation };
}
function ok(r, status = 0) { assert.ifError(r.error); assert.equal(r.status, status, `${r.error || ''}\n${r.stdout}\n${r.stderr}`); }
function restored(g, init = original) {
  assert.equal(fs.readFileSync(g.p('etc/init.d/chirpstack'), 'utf8'), init);
  assert.equal(fs.readFileSync(g.p('opt/chirpstack/backup.sh'), 'utf8'), '#!/bin/sh\necho old-backup\n');
  assert.equal(fs.readFileSync(g.p('opt/chirpstack/restore.sh'), 'utf8'), '#!/bin/sh\necho old-restore\n');
  assert.equal(fs.statSync(g.p('opt/chirpstack/restore.sh')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(g.p('opt/chirpstack/backup.sh')).mode & 0o777, 0o750);
  assert.deepEqual(g.journal(), [1, 1]);
  assert.ok(fs.existsSync(g.p('running')));
}

for (const [variant, init, expected] of initVariants) {
  test(`field init ${variant} converts with ${shell}, backup manifest and byte-identical current feed scripts`, async (t) => {
    const g = await gateway(t, init);
    const before = g.state();
    const check = g.run(); ok(check, 3); assert.match(check.stdout, /needs conversion/);
    assert.match(check.stdout, /init pragmas: no/); assert.match(check.stdout, /journal: DELETE/);
    assert.match(check.stdout, /running: yes/); assert.match(check.stdout, /backup\/restore WAL-aware: no/);
    assert.deepEqual(g.state(), before, 'check does not open SQLite or write');
    const applied = g.run(['--apply']); ok(applied); assert.match(applied.stdout, /OK: ChirpStack SQLite on WAL; backup/);
    assert.deepEqual(g.journal(), [2, 2]);
    assert.equal(fs.readFileSync(g.p('etc/init.d/chirpstack'), 'utf8'), expected);
    assert.equal(fs.statSync(g.p('etc/init.d/chirpstack')).mode & 0o777, 0o751);
    assert.equal(fs.readFileSync(path.join(g.backup(), 'chirpstack.init'), 'utf8'), init);
    assert.equal(fs.statSync(g.backup()).mode & 0o777, 0o700);
    const manifest = fs.readFileSync(path.join(g.backup(), 'MANIFEST.txt'), 'utf8');
    for (const file of ['chirpstack.sqlite', 'chirpstack.init', 'backup.sh', 'restore.sh']) assert.ok(manifest.includes(`${hash(path.join(g.backup(), file))}  ${file}\n`));
    for (const file of ['backup.sh', 'restore.sh']) assert.deepEqual(fs.readFileSync(g.p(`opt/chirpstack/${file}`)), fs.readFileSync(path.join(feed, file)));
    ok(g.run(['--check']));
    const once = g.state(); const backupNames = fs.readdirSync(g.p('srv/backup'));
    const twice = g.run(['--apply']); ok(twice); assert.match(twice.stdout, /OK: already WAL/);
    assert.deepEqual(g.state(), once); assert.deepEqual(fs.readdirSync(g.p('srv/backup')), backupNames);
  });

  test(`field init ${variant} keeps its bytes through explicit and automatic rollback`, async (t) => {
    const g = await gateway(t, init);
    ok(g.run(['--apply']));
    ok(g.run(['--rollback', g.backup()]));
    restored(g, init);
    const read = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite'));
    assert.equal(read.prepare('SELECT count(*) AS n FROM uplinks').get().n, 2); read.close();

    const failed = await gateway(t, init);
    const result = failed.run(['--apply'], { TEST_BAD_CONFIG: '1' });
    ok(result, 1); assert.match(result.stderr, /ROLLED BACK:/); restored(failed, init);
  });
}

function withoutFlock(g) {
  const dir = g.p('without-flock'); fs.mkdirSync(dir);
  for (const name of ['sh', 'mkdir', 'cat', 'mv', 'rm', 'rmdir', 'awk', 'chmod', 'sed', 'grep', 'ln', 'touch']) {
    const target = process.env.PATH.split(path.delimiter).map(d => path.join(d, name)).find(file => {
      try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
    });
    assert.ok(target, name); fs.symlinkSync(target, path.join(dir, name));
  }
  const PATH = `${g.p('bin')}:${dir}`;
  const probe = spawnSync('/bin/sh', ['-c', 'command -v flock'], { env: { ...g.env, PATH } });
  assert.ifError(probe.error);
  assert.ok([1, 127].includes(probe.status), 'the installed helpers would have no flock command');
  return { PATH };
}
for (const state of ['DELETE', 'WAL with old helpers', 'WAL with current helpers']) {
  for (const mode of ['--apply', '--check']) test(`${mode} refuses missing flock before any change: ${state}`, async t => {
    const g = await gateway(t, state === 'DELETE' ? original : converted);
    if (state !== 'DELETE') {
      const db = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite')); db.exec('PRAGMA journal_mode=WAL'); db.close();
    }
    if (state === 'WAL with current helpers') {
      for (const name of ['backup.sh', 'restore.sh']) fs.copyFileSync(path.join(feed, name), g.p(`opt/chirpstack/${name}`));
    }
    const before = g.state();
    const result = g.run([mode], withoutFlock(g)); ok(result, 1);
    assert.match(result.stderr, /flock is required.*not modified/);
    assert.doesNotMatch(result.stdout, /OK:|backup\/restore WAL-aware: yes/);
    assert.deepEqual(g.state(), before);
    assert.deepEqual(fs.readdirSync(g.p('srv/backup')), []);
    assert.equal(fs.existsSync(g.p('service-calls')), false, 'no service downtime');
  });
}
test('missing flock permits conversion when no helpers are installed', async t => {
  const g = await gateway(t); const extra = withoutFlock(g);
  fs.rmSync(g.p('opt/chirpstack'), { recursive: true });
  ok(g.run(['--apply'], extra));
  assert.deepEqual(g.journal(), [2, 2]);
  assert.equal(fs.existsSync(g.p('opt/chirpstack')), false);
  ok(g.run(['--check'], extra));
});

test('streamed operator command reads its embedded helper without consuming script input', async (t) => {
  const g = await gateway(t);
  const r = spawnSync(shell, [...shellArgs, '-s', '--', '--apply'], { input: fs.readFileSync(script), env: g.env, encoding: 'utf8', timeout: 20000 });
  ok(r); assert.deepEqual(g.journal(), [2, 2]);
});

for (const [variant, , wal] of [...initVariants,
  ['with captured field diagnostics', null, fs.readFileSync(path.join(fixtures, 'chirpstack.init.wal'), 'utf8')],
]) test(`captured WAL fixture ${variant} remains byte-identical on an idempotent apply`, async (t) => {
  const g = await gateway(t, wal);
  const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite')); d.exec('PRAGMA journal_mode=WAL'); d.close();
  // A fully converted gateway already carries the WAL-aware helpers.
  for (const file of ['backup.sh', 'restore.sh']) fs.copyFileSync(path.join(feed, file), g.p(`opt/chirpstack/${file}`));
  const before = g.state(); ok(g.run(['--apply'])); assert.deepEqual(g.state(), before);
});

for (const [name, init, env, message] of [
  ['no anchor', original.replace('\t\tpath=', '\tpath='), {}, /init script shape not recognised/],
  ['two anchors', original.replace('\t\tpath="/srv/chirpstack/chirpstack.sqlite"', '\t\tpath="/srv/chirpstack/chirpstack.sqlite"\n\t\tpath="/srv/chirpstack/chirpstack.sqlite"'), {}, /init script shape not recognised/],
  ['existing non-WAL pragmas', original.replace('\t\t[sqlite]', '\t\t[sqlite]\n\t\tpragmas = ["journal_mode = DELETE"]'), {}, /init script shape not recognised/],
  ['wrong heredoc delimiter', original.replace('<<- EOF', '<<- OTHER'), {}, /init script shape not recognised/],
  ['anchor outside configuration', original.replace('configuration() {', 'something_else() {'), {}, /init script shape not recognised/],
  ['not root', original, { TEST_UID: '1000' }, /must run as root/],
  ['too little space', original, { TEST_FREE_KB: '0' }, /not enough free space/],
  ['service will not stop', original, { TEST_STOP_STUCK: '1' }, /did not stop within 30 seconds/],
]) test(`refusal: ${name} changes no runtime bytes`, async (t) => {
  const g = await gateway(t, init); const before = g.state(); const r = g.run(['--apply'], env);
  ok(r, 1); assert.match(r.stderr, message); assert.deepEqual(g.state(), before);
  if (env.TEST_STOP_STUCK) assert.match(fs.readFileSync(g.p('service-calls'), 'utf8'), /stop\nstart\n/);
});

for (const [name, target, extra, message] of [
  ['init missing', 'etc/init.d/chirpstack', {}, /init script shape not recognised/],
  ['database missing', 'srv/chirpstack/chirpstack.sqlite', {}, /ENOENT.*chirpstack\.sqlite/],
  ['sqlite module missing', null, { OSI_CS_SQLITE_MODULE: '/nonexistent/sqlite3' }, /Cannot find module.*sqlite3/],
]) test(`precondition: ${name} refuses before stopping`, async (t) => {
  const g = await gateway(t);
  if (target) fs.unlinkSync(g.p(target));
  const marker = fs.statSync(g.p('running')).mtimeMs;
  const r = g.run(['--apply'], extra); ok(r, 1); assert.match(r.stderr, message);
  assert.equal(fs.statSync(g.p('running')).mtimeMs, marker);
  assert.deepEqual(fs.readdirSync(g.p('srv/backup')), []);
});

test('stopped sidecars are captured, hashed, and retained alongside the database', async (t) => {
  const g = await gateway(t);
  const file = g.p('srv/chirpstack/chirpstack.sqlite');
  const child = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(process.argv[1]); d.exec('PRAGMA journal_mode=WAL; INSERT INTO uplinks VALUES (9)'); process.kill(process.pid, 'SIGKILL');`, file]);
  assert.equal(child.signal, 'SIGKILL');
  // A zeroed cold journal is valid beside SQLite's real WAL/SHM files.
  fs.writeFileSync(file + '-journal', Buffer.alloc(512));
  const sidecars = Object.fromEntries(['-wal', '-shm', '-journal'].map((ext) => [ext, fs.readFileSync(file + ext)]));
  ok(g.run(['--apply']));
  for (const [ext, bytes] of Object.entries(sidecars)) assert.deepEqual(fs.readFileSync(path.join(g.backup(), 'chirpstack.sqlite' + ext)), bytes);
  const d = new DatabaseSync(file); assert.equal(d.prepare('SELECT count(*) AS n FROM uplinks').get().n, 3); d.close();
});

test('missing /opt/chirpstack is left absent', async (t) => {
  const g = await gateway(t); fs.rmSync(g.p('opt/chirpstack'), { recursive: true });
  ok(g.run(['--apply'])); assert.equal(fs.existsSync(g.p('opt/chirpstack')), false);
  ok(g.run(['--rollback', g.backup()]));
});

test('integrity failure restarts the unchanged service', async (t) => {
  const g = await gateway(t);
  const file = g.p('srv/chirpstack/chirpstack.sqlite'); const bytes = fs.readFileSync(file); bytes[100] = 0; fs.writeFileSync(file, bytes);
  const before = g.state(); const r = g.run(['--apply']); ok(r, 1); assert.match(r.stderr, /SQLite integrity check failed/);
  assert.deepEqual(g.state(), before); assert.ok(fs.existsSync(g.p('running')));
});

for (const [name, extra] of [
  ['start fails', { TEST_START_FAIL: '1' }],
  ['header never switches', { TEST_NO_WAL: '1' }],
  ['API port unavailable', { TEST_BAD_PORT: '1' }],
  ['API port unavailable with slow helper launches', { TEST_BAD_PORT: '1', TEST_SLOW_POLL: '1' }],
  ['generated config lacks pragmas', { TEST_BAD_CONFIG: '1' }],
  ['fsync fails before init publication', { TEST_FSYNC_FAIL: '1' }],
  ['daemon respawns during the ten-second wait', { TEST_RESPAWN: '1' }],
  ['dies during the ten-second wait', { TEST_LATE_DEATH: '1' }],
]) test(`automatic rollback: ${name}`, async (t) => {
  const g = await gateway(t); const r = g.run(['--apply'], extra);
  ok(r, 1); assert.match(r.stderr, /ROLLED BACK:/); restored(g);
  if (extra.TEST_BAD_PORT) {
    const polls = fs.readFileSync(g.p('bad-port-polls'), 'utf8').trim().split('\n').length;
    assert.ok(polls > 1 && polls <= 6, 'virtual 60-second health deadline takes at most six polls');
  }
  if (extra.TEST_BAD_CONFIG || extra.TEST_LATE_DEATH || extra.TEST_NO_WAL) {
    const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite'));
    assert.equal(d.prepare('SELECT count(*) AS n FROM uplinks').get().n, 2, 'keep uplinks written after conversion'); d.close();
  }
});

test('explicit rollback preserves new data and verifies manifest before stopping', async (t) => {
  const g = await gateway(t); ok(g.run(['--apply']));
  const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite')); d.exec('INSERT INTO uplinks VALUES (3)'); d.close();
  ok(g.run(['--rollback', g.backup()])); restored(g);
  const read = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite'));
  assert.equal(read.prepare('SELECT count(*) AS n FROM uplinks').get().n, 3); read.close();
  fs.appendFileSync(path.join(g.backup(), 'chirpstack.init'), '# tampered\n');
  const before = g.state(); const tampered = g.run(['--rollback', g.backup()]); ok(tampered, 1);
  assert.match(tampered.stderr, /backup manifest mismatch: chirpstack\.init/); assert.deepEqual(g.state(), before);
});

test('rollback removes helper scripts that were originally absent', async (t) => {
  const g = await gateway(t); fs.unlinkSync(g.p('opt/chirpstack/backup.sh')); fs.unlinkSync(g.p('opt/chirpstack/restore.sh'));
  ok(g.run(['--apply'])); ok(g.run(['--rollback', g.backup()]));
  assert.equal(fs.existsSync(g.p('opt/chirpstack/backup.sh')), false);
  assert.equal(fs.existsSync(g.p('opt/chirpstack/restore.sh')), false);
});

test('shell syntax parses and deploy notice is read-only and never fails', async (t) => {
  ok(spawnSync('sh', ['-n', script], { encoding: 'utf8' }));
  ok(spawnSync(shell, [...shellArgs, '-n', script], { encoding: 'utf8' }));
  const deploy = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  const fn = /^note_chirpstack_wal\(\) \{\n[\s\S]*?\n\}/m.exec(deploy);
  assert.ok(fn); assert.match(deploy, /\nnote_chirpstack_wal\n/);
  const g = await gateway(t);
  const run = () => spawnSync(shell, [...shellArgs, '-c', `set -eu\n${fn[0]}\nnote_chirpstack_wal\necho carried-on`], { env: { ...g.env, OSI_CS_DB: g.p('srv/chirpstack/chirpstack.sqlite') }, encoding: 'utf8' });
  const before = g.state(); const r = run(); ok(r); assert.match(r.stdout, /NOTE:.*chirpstack-sqlite-wal.sh --apply/); assert.match(r.stdout, /carried-on/); assert.deepEqual(g.state(), before);
  ok(g.run(['--apply'])); const wal = run(); ok(wal); assert.doesNotMatch(wal.stdout, /NOTE:/);
  fs.unlinkSync(g.p('srv/chirpstack/chirpstack.sqlite')); ok(run());
});

for (const init of [converted, fs.readFileSync(path.join(fixtures, 'feed-670/chirpstack.init'), 'utf8')]) {
  test('configured init with DELETE header only restarts, then becomes an idempotent no-op', async (t) => {
    const g = await gateway(t, init); const before = g.state();
    const check = g.run(); ok(check, 3); assert.match(check.stdout, /init pragmas: yes; journal: DELETE/);
    ok(g.run(['--apply'])); assert.deepEqual(g.journal(), [2, 2]);
    assert.deepEqual(g.state()['etc/init.d/chirpstack'], before['etc/init.d/chirpstack']);
    // The restart path also installs the WAL-aware helpers (a stock restore.sh would replay a stale WAL).
    for (const file of ['backup.sh', 'restore.sh']) assert.deepEqual(fs.readFileSync(g.p(`opt/chirpstack/${file}`)), fs.readFileSync(path.join(feed, file)));
    fs.unlinkSync(g.p('running')); fs.unlinkSync(g.p('proc/1/exe')); fs.rmSync(g.p('opt/chirpstack'), { recursive: true });
    const checked = g.run(); ok(checked); assert.match(checked.stdout, /running: no; backup\/restore WAL-aware: no/);
    const once = hash(g.p('etc/init.d/chirpstack')); ok(g.run(['--apply']));
    assert.equal(hash(g.p('etc/init.d/chirpstack')), once);
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
  });
}

test('verified full stale lock names its backup and phase-specific recovery action', async (t) => {
  const g = await gateway(t); ok(g.run(['--apply']));
  const backup = g.backup(); const lock = g.p('srv/backup/.chirpstack-maintenance.lock');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'backup'), backup + '\n');
  fs.writeFileSync(path.join(lock, 'state'), 'full installing\n');
  const before = g.state(); const r = g.run(['--apply']); ok(r, 1);
  assert.match(r.stderr, /lock remains/); assert.match(r.stderr, /--rollback /);
  assert.ok(r.stderr.includes(backup)); assert.ok(r.stderr.includes(lock)); assert.deepEqual(g.state(), before);
});

for (const signal of ['HUP', 'INT', 'TERM', 'PIPE']) {
  test(`${signal} during stop restarts ChirpStack and releases the lock`, async (t) => {
    const g = await gateway(t); const r = g.run(['--apply'], { TEST_STOP_SIGNAL: signal });
    ok(r, signal === 'PIPE' ? 0 : 1);
    assert.ok(fs.existsSync(g.p('running')));
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
    assert.match(fs.readFileSync(g.p('service-calls'), 'utf8'), /start/);
  });
}

test('TERM after init edit uses lossless rollback and releases lock', async (t) => {
  const g = await gateway(t); const r = g.run(['--apply'], { TEST_START_SIGNAL: 'TERM' });
  ok(r, 1); assert.match(r.stderr, /ROLLED BACK:/); restored(g);
  assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
  const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite'));
  assert.equal(d.prepare('SELECT count(*) AS n FROM uplinks').get().n, 2); d.close();
});

test('dropped output pipe still attempts restart and releases lock', async (t) => {
  const g = await gateway(t);
  const r = await new Promise((resolve, reject) => {
    const child = spawn(shell, [...shellArgs, script, '--apply'], { env: g.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('pipe test timed out')); }, 20000);
    child.stdout.once('data', () => child.stdout.destroy());
    child.stderr.resume(); child.once('error', reject);
    child.once('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal }); });
  });
  assert.equal(r.signal, null); assert.ok([0, 1].includes(r.status));
  assert.ok(fs.existsSync(g.p('running')));
  assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
});

test('an init helper process is not mistaken for the ChirpStack daemon', async (t) => {
  const g = await gateway(t);
  fs.unlinkSync(g.p('proc/1/exe')); fs.symlinkSync('/bin/busybox', g.p('proc/1/exe'));
  fs.writeFileSync(g.p('proc/1/cmdline'), '/bin/sh\0/etc/init.d/chirpstack\0start\0');
  const r = g.run(); ok(r, 3); assert.match(r.stdout, /running: no/);
});

let nativeModule;
try { nativeModule = process.env.OSI_CS_TEST_SQLITE_MODULE || require.resolve('sqlite3', { paths: [__dirname, path.join(repo, 'web/react-gui')] }); require(nativeModule); }
catch (error) { if (process.env.OSI_CS_TEST_SQLITE_MODULE) throw error; }
test('native sqlite3 callback integrity and lossless DELETE rollback', { skip: nativeModule ? false : 'native sqlite3 unavailable; callback adapter runs in the main suite' }, async (t) => {
  const g = await gateway(t); ok(g.run(['--apply'], { OSI_CS_SQLITE_MODULE: nativeModule }));
  ok(g.run(['--rollback', g.backup()], { OSI_CS_SQLITE_MODULE: nativeModule })); restored(g);
  const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite'));
  assert.equal(d.prepare('SELECT count(*) AS n FROM uplinks').get().n, 2); d.close();
});

for (const [name, extra, message] of [
  ['one config file cannot be restored', { TEST_RESTORE_FAIL: '1' }, /NOT RESTORED: backup\.sh.*injected/],
  ['DELETE conversion fails', { TEST_DELETE_FAIL: '1' }, /NOT RESTORED: SQLite DELETE journal/],
]) test(`incomplete rollback starts ChirpStack and retains recovery metadata: ${name}`, async (t) => {
  const g = await gateway(t);
  const r = g.run(['--apply'], { TEST_BAD_CONFIG: '1', ...extra }); ok(r, 1);
  assert.match(r.stderr, /rollback incomplete/); assert.match(r.stderr, message);
  assert.match(r.stderr, /RESTORED: ChirpStack started/);
  assert.match(r.stderr, /RESTORED: chirpstack\.init/); assert.match(r.stderr, /RESTORED: restore\.sh/);
  assert.ok(fs.existsSync(g.p('running')));
  assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), true);
  assert.equal(fs.readFileSync(g.p('srv/backup/.chirpstack-maintenance.lock/state'), 'utf8'), 'full recovery-failed\n');
  const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite'));
  assert.equal(d.prepare('SELECT count(*) AS n FROM uplinks').get().n, 2); d.close();
});

test('backup hash mismatch refuses before editing init and restarts unchanged service', async (t) => {
  const g = await gateway(t); const before = g.state();
  const r = g.run(['--apply'], { TEST_BAD_COPY: '1' }); ok(r, 1);
  assert.match(r.stderr, /backup copy mismatch/); assert.deepEqual(g.state(), before);
  assert.match(fs.readFileSync(g.p('service-calls'), 'utf8'), /stop\nstart\n/);
  assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
});

test('already stopped service tolerates nonzero procd stop result', async (t) => {
  const g = await gateway(t); fs.unlinkSync(g.p('running')); fs.unlinkSync(g.p('proc/1/exe'));
  ok(g.run(['--apply'])); assert.deepEqual(g.journal(), [2, 2]);
});

test('stale lock without a recorded backup refuses without guessing one', async (t) => {
  const g = await gateway(t, converted);
  const backup = g.p('srv/backup/chirpstack-wal-20260101T000000Z'); fs.mkdirSync(backup);
  fs.mkdirSync(g.p('srv/backup/.chirpstack-maintenance.lock'), { recursive: true });
  const r = g.run(['--apply']); ok(r, 1);
  assert.match(r.stderr, /no backup directory was recorded/);
  assert.ok(!r.stderr.includes('--rollback'), 'never points at a guessed backup');
  assert.ok(!r.stderr.includes(backup));
  assert.equal(fs.existsSync(g.p('service-calls')), false);
});

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('a kill between the init edit and the helper install is repaired by the next --apply', async (t) => {
  const g = await gateway(t);
  const killed = g.run(['--apply'], { TEST_KILL_BEFORE_INSTALL: '1' });
  assert.notEqual(killed.status, 0);
  assert.equal(fs.readFileSync(g.p('etc/init.d/chirpstack'), 'utf8'), converted, 'the init edit landed');
  assert.equal(fs.readFileSync(g.p('opt/chirpstack/restore.sh'), 'utf8'), '#!/bin/sh\necho old-restore\n', 'the stock helper remained');
  const lock = g.p('srv/backup/.chirpstack-maintenance.lock');
  assert.ok(fs.existsSync(path.join(lock, 'backup')), 'an uncatchable kill leaves the lock and its recorded backup');
  const refused = g.run(['--apply']); ok(refused, 1); assert.match(refused.stderr, /--rollback /);
  fs.rmSync(lock, { recursive: true });
  const check = g.run(['--check']); ok(check, 3);
  sleepSync(1100); // backup directories are named by the second
  ok(g.run(['--apply']));
  assert.deepEqual(g.journal(), [2, 2]);
  for (const file of ['backup.sh', 'restore.sh']) assert.deepEqual(fs.readFileSync(g.p(`opt/chirpstack/${file}`)), fs.readFileSync(path.join(feed, file)));
  ok(g.run(['--check']));
});

test('already WAL with stale helpers installs them without touching ChirpStack or the database', async (t) => {
  const g = await gateway(t, converted);
  const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite')); d.exec('PRAGMA journal_mode=WAL'); d.close();
  assert.deepEqual(g.journal(), [2, 2]);
  const check = g.run(['--check']); ok(check, 3); assert.match(check.stdout, /needs WAL-aware backup\/restore scripts/);
  const dbBefore = hash(g.p('srv/chirpstack/chirpstack.sqlite'));
  const applied = g.run(['--apply']); ok(applied);
  assert.match(applied.stdout, /OK: already WAL; WAL-aware backup\/restore scripts installed; previous helpers in /);
  assert.equal(fs.existsSync(g.p('service-calls')), false, 'ChirpStack was neither stopped nor started');
  assert.equal(hash(g.p('srv/chirpstack/chirpstack.sqlite')), dbBefore);
  for (const file of ['backup.sh', 'restore.sh']) assert.deepEqual(fs.readFileSync(g.p(`opt/chirpstack/${file}`)), fs.readFileSync(path.join(feed, file)));
  const saved = fs.readdirSync(g.backup()).sort();
  assert.deepEqual(saved, ['ABSENT.txt', 'MANIFEST.txt', 'backup.sh', 'restore.sh'], 'only the previous helpers are kept; the live database is never copied');
  assert.equal(fs.readFileSync(path.join(g.backup(), 'restore.sh'), 'utf8'), '#!/bin/sh\necho old-restore\n');
  ok(g.run(['--check']));
  const names = fs.readdirSync(g.p('srv/backup'));
  const again = g.run(['--apply']); ok(again); assert.match(again.stdout, /OK: already WAL$/m);
  assert.deepEqual(fs.readdirSync(g.p('srv/backup')), names);
});

test('--rollback refuses when the current init no longer matches the backup', async (t) => {
  const g = await gateway(t); ok(g.run(['--apply']));
  fs.appendFileSync(g.p('etc/init.d/chirpstack'), '# changed after conversion\n');
  const calls = fs.readFileSync(g.p('service-calls'), 'utf8');
  const before = g.state(); const r = g.run(['--rollback', g.backup()]); ok(r, 1);
  assert.match(r.stderr, /backup init does not match the current init; not modified/);
  assert.deepEqual(g.state(), before);
  assert.equal(fs.readFileSync(g.p('service-calls'), 'utf8'), calls, 'ChirpStack was not stopped');
});

for (const init of [converted, fs.readFileSync(path.join(fixtures, 'feed-670/chirpstack.init'), 'utf8')]) {
  test('configured init whose header fails to switch retains data during rollback', async (t) => {
    const g = await gateway(t, init); const r = g.run(['--apply'], { TEST_NO_WAL: '1' }); ok(r, 1);
    assert.match(r.stderr, /SQLite header did not switch/); assert.match(r.stderr, /NOT RESTORED: expected WAL journal, found DELETE/); assert.doesNotMatch(r.stderr, /ROLLED BACK:/);
    assert.equal(fs.readFileSync(g.p('etc/init.d/chirpstack'), 'utf8'), init);
    assert.deepEqual(g.journal(), [1, 1]); assert.ok(fs.existsSync(g.p('running')));
    const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite'));
    assert.equal(d.prepare('SELECT count(*) AS n FROM uplinks').get().n, 2); d.close();
  });
}

test('successful apply cleans interrupted hidden publication temps', async (t) => {
  const g = await gateway(t);
  const temp = g.p('etc/init.d/.chirpstack.wal-12345'); fs.writeFileSync(temp, 'partial', { mode: 0o700 });
  ok(g.run(['--apply'])); assert.equal(fs.existsSync(temp), false);
  assert.deepEqual(fs.readdirSync(g.p('etc/init.d')), ['chirpstack']);
});

test('Node unavailable refuses with its own message before downtime', async (t) => {
  const g = await gateway(t); const before = g.state(); const empty = g.p('empty-bin'); fs.mkdirSync(empty);
  const r = g.run(['--apply'], { PATH: empty }); ok(r, 1); assert.match(r.stderr, /Node unavailable/);
  assert.deepEqual(g.state(), before); assert.equal(fs.existsSync(g.p('service-calls')), false);
});

for (const absent of [false, true]) test(`helper-only second-file failure restores originals, initially absent=${absent}`, async (t) => {
  const g = await gateway(t, converted);
  const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite')); d.exec('PRAGMA journal_mode=WAL'); d.close();
  if (absent) fs.unlinkSync(g.p('opt/chirpstack/backup.sh'));
  const dbBefore = hash(g.p('srv/chirpstack/chirpstack.sqlite'));
  const initBefore = fs.readFileSync(g.p('etc/init.d/chirpstack'));
  const r = g.run(['--apply'], { TEST_SECOND_HELPER_FAIL: '1' }); ok(r, 1);
  assert.match(r.stderr, /injected second helper install failure/);
  assert.match(r.stderr, /ROLLED BACK: previous backup\/restore helpers/);
  if (absent) assert.equal(fs.existsSync(g.p('opt/chirpstack/backup.sh')), false);
  else {
    assert.equal(fs.readFileSync(g.p('opt/chirpstack/backup.sh'), 'utf8'), '#!/bin/sh\necho old-backup\n');
    assert.equal(fs.statSync(g.p('opt/chirpstack/backup.sh')).mode & 0o777, 0o750);
  }
  assert.equal(fs.readFileSync(g.p('opt/chirpstack/restore.sh'), 'utf8'), '#!/bin/sh\necho old-restore\n');
  assert.equal(fs.statSync(g.p('opt/chirpstack/restore.sh')).mode & 0o777, 0o700);
  assert.deepEqual(fs.readFileSync(g.p('etc/init.d/chirpstack')), initBefore);
  assert.equal(hash(g.p('srv/chirpstack/chirpstack.sqlite')), dbBefore);
  assert.equal(fs.existsSync(g.p('service-calls')), false, 'helper-only rollback never stops or starts ChirpStack');
  assert.ok(fs.existsSync(g.p('running')));
  assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
});

for (const [name, list] of [
  ['later timeout override', '"busy_timeout = 5000", "journal_mode = WAL", "foreign_keys = ON", "busy_timeout = 1000"'],
  ['missing foreign keys', '"busy_timeout = 5000", "journal_mode = WAL"'],
  ['later journal override', '"busy_timeout = 5000", "journal_mode = WAL", "foreign_keys = ON", "journal_mode = DELETE"'],
]) test(`review effective pragmas: ${name} requires conversion and is repaired`, async t => {
  const init = original.replace('\t\tpath="/srv/chirpstack/chirpstack.sqlite"\n', `$&\t\tpragmas = [${list}]\n`);
  const g = await gateway(t, init);
  const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite')); d.exec('PRAGMA journal_mode=WAL'); d.close();
  for (const f of ['backup.sh', 'restore.sh']) fs.copyFileSync(path.join(feed, f), g.p('opt/chirpstack/' + f));
  const check = g.run(['--check']); ok(check, 3); assert.match(check.stdout, /init pragmas: no/);
  ok(g.run(['--apply'])); assert.equal(fs.readFileSync(g.p('etc/init.d/chirpstack'), 'utf8'), converted);
});
test('review refuses DELETE rollback to an init that requests WAL', async t => {
  const g = await gateway(t, converted); ok(g.run(['--apply']));
  const before = g.state(), calls = fs.readFileSync(g.p('service-calls'), 'utf8');
  const r = g.run(['--rollback', g.backup()]); ok(r, 1); assert.match(r.stderr, /target.*WAL|WAL.*target/);
  assert.deepEqual(g.state(), before); assert.equal(fs.readFileSync(g.p('service-calls'), 'utf8'), calls);
});
for (const mode of ['apply', 'rollback']) test(`review rechecks ${mode} after acquiring lock`, async t => {
  const g = await gateway(t);
  if (mode === 'rollback') ok(g.run(['--apply']));
  const backup = mode === 'rollback' ? g.backup() : null;
  const calls = fs.existsSync(g.p('service-calls')) ? fs.readFileSync(g.p('service-calls'), 'utf8') : '';
  fs.writeFileSync(g.p('bin/mkdir'), `#!/bin/sh
case "$*" in *.lock*)
  if [ ! -f "$OSI_CS_ROOT/raced-init" ]; then
    echo raced > "$OSI_CS_ROOT/raced-init"
    ${mode === 'apply' ? 'sed -i \'s/path=/unexpected_path=/\' "$OSI_CS_ROOT/etc/init.d/chirpstack"' : 'echo "# changed by previous owner" >> "$OSI_CS_ROOT/etc/init.d/chirpstack"'}
  fi ;;
esac
exec /usr/bin/mkdir "$@"
`, { mode: 0o755 });
  const r = g.run(mode === 'apply' ? ['--apply'] : ['--rollback', backup]); ok(r, 1);
  assert.equal(fs.readFileSync(g.p('raced-init'), 'utf8'), 'raced\n', 'the lock-acquisition race was injected');
  assert.equal(fs.existsSync(g.p('service-calls')) ? fs.readFileSync(g.p('service-calls'), 'utf8') : '', calls, 'raced state refused before service stop');
});
test('review helper-state failure cannot report already WAL', async t => {
  const g = await gateway(t, converted);
  const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite')); d.exec('PRAGMA journal_mode=WAL'); d.close();
  fs.unlinkSync(g.p('opt/chirpstack/backup.sh')); fs.mkdirSync(g.p('opt/chirpstack/backup.sh'));
  const r = g.run(['--apply']); ok(r, 1); assert.doesNotMatch(r.stdout, /OK: already WAL/);
  assert.equal(fs.existsSync(g.p('service-calls')), false);
});
test('review hashing never reads a database-sized buffer', async t => {
  const g = await gateway(t); const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite'));
  d.exec('CREATE TABLE payload (b BLOB); INSERT INTO payload VALUES (zeroblob(4194304))'); d.close();
  ok(g.run(['--apply'], { TEST_BOUNDED_HASH: '1' }));
  ok(g.run(['--rollback', g.backup()], { TEST_BOUNDED_HASH: '1' })); restored(g);
});
for (const kind of ['helper-only', 'full-incomplete']) test(`review stale recovery instructions match ${kind} phase`, async t => {
  const g = await gateway(t, kind === 'helper-only' ? converted : original);
  if (kind === 'helper-only') { const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite')); d.exec('PRAGMA journal_mode=WAL'); d.close(); }
  const killed = g.run(['--apply'], kind === 'helper-only' ? { TEST_KILL_AFTER_FIRST_HELPER: '1' } : { TEST_KILL_DURING_BACKUP: '1' });
  assert.ifError(killed.error); assert.notEqual(killed.status, 0);
  const r = g.run(['--apply']); ok(r, 1);
  if (kind === 'helper-only') {
    assert.match(r.stderr, /--recover-helpers/);
    const dir = g.backup();
    fs.rmSync(g.p('srv/backup/.chirpstack-maintenance.lock'), { recursive: true });
    ok(g.run(['--recover-helpers', dir]));
    assert.equal(fs.readFileSync(g.p('opt/chirpstack/backup.sh'), 'utf8'), '#!/bin/sh\necho old-backup\n');
    assert.equal(fs.existsSync(g.p('service-calls')), false);
  } else {
    assert.match(r.stderr, /incomplete full backup; not a rollback target/);
    assert.doesNotMatch(r.stderr, /then run .*--rollback/);
    assert.equal(fs.existsSync(g.p('running')), false);
  }
});
for (const ownerMode of ['helper', 'one-shot']) test(`review maintenance lock shared with ${ownerMode} owner`, async t => {
  const g = await gateway(t); fs.mkdirSync(g.p('srv/redis')); fs.writeFileSync(g.p('srv/redis/dump.rdb'), 'dump'); fs.writeFileSync(g.p('redis-running'), 'yes');
  fs.writeFileSync(g.p('bin/service'), `#!/bin/sh
if [ "$1" = chirpstack ]; then exec "$OSI_CS_ROOT/service" "$2"; fi
case "$2" in stop) rm -f "$OSI_CS_ROOT/redis-running";; start) echo yes > "$OSI_CS_ROOT/redis-running";; esac
`, { mode: 0o755 });
  fs.writeFileSync(g.p('bin/pidof'), '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$OSI_CS_ROOT/pidof-calls"\ncase "$1" in chirpstack) test -f "$OSI_CS_ROOT/running";; redis-server) test -f "$OSI_CS_ROOT/redis-running";; esac\n', { mode: 0o755 });
  fs.writeFileSync(g.p('bin/sqlite3'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  const helper = path.join(feed, 'backup.sh');
  const owner = spawn(shell, g.invocation(ownerMode === 'helper' ? helper : script, ownerMode === 'helper' ? [] : ['--apply']), { env: { ...g.env, TEST_PAUSE_STOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  owner.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  owner.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    owner.on('error', reject); owner.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(g.p('stop-paused'))) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); }
    const calls = fs.readFileSync(g.p('service-calls'), 'utf8');
    const contender = ownerMode === 'helper' ? g.run(['--apply']) : spawnSync(shell, g.invocation(helper), { env: g.env, encoding: 'utf8', timeout: 10000 });
    ok(contender, 1);
    assert.equal(fs.readFileSync(g.p('service-calls'), 'utf8'), calls);
    assert.equal(fs.existsSync(g.p('running')), false);
  } finally {
    fs.writeFileSync(g.p('stop-resume'), 'yes');
    const timer = setTimeout(() => { stderr += '\nowner exceeded 10-second completion deadline'; owner.kill('SIGKILL'); }, 10000);
    try {
      const result = await completed;
      t.diagnostic(`owner ${ownerMode}: status ${result.status}, signal ${result.signal}\n${result.stdout}\n${result.stderr}`);
      ok(result);
    } finally { clearTimeout(timer); }
  }
  assert.match(fs.readFileSync(g.p('pidof-calls'), 'utf8'), /chirpstack/, 'the process-probe stub ran');
});

test('review WAL-requesting automatic recovery reports WAL and retains current helpers', async t => {
  const g = await gateway(t, converted);
  const r = g.run(['--apply'], { TEST_START_SIGNAL: 'TERM' }); ok(r, 1);
  assert.match(r.stderr, /ROLLED BACK:/); assert.match(r.stderr, /WAL-configured init retained/);
  assert.doesNotMatch(r.stderr, /RESTORED: SQLite DELETE journal/);
  assert.deepEqual(g.journal(), [2, 2]);
  for (const f of ['backup.sh', 'restore.sh']) assert.deepEqual(fs.readFileSync(g.p('opt/chirpstack/' + f)), fs.readFileSync(path.join(feed, f)));
});
