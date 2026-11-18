'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const repo = path.resolve(__dirname, '..');
const script = path.join(repo, 'scripts/pi/chirpstack-sqlite-wal.sh');
const fixtures = path.join(__dirname, 'fixtures/chirpstack-sqlite-wal');
const original = fs.readFileSync(path.join(fixtures, 'chirpstack.init.orig'), 'utf8');
const pragma = '\t\tpragmas = ["busy_timeout = 5000", "journal_mode = WAL", "foreign_keys = ON"]';
const converted = original.replace('\t\tpath="/srv/chirpstack/chirpstack.sqlite"\n', `$&${pragma}\n`);
const shell = process.env.OSI_CS_TEST_SHELL || (spawnSync('busybox', ['sh', '-c', 'exit 0']).status === 0 ? 'busybox' : 'dash');
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
  fs.symlinkSync(p('running'), p('proc/1/comm'));
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const exe = (name, content) => fs.writeFileSync(p(`bin/${name}`), `#!/bin/sh\n${content}\n`, { mode: 0o755 });
  exe('node', `if [ "\${TEST_BAD_PORT:-0}" = 1 ] && grep -q pragmas "$OSI_CS_ROOT/etc/init.d/chirpstack"; then export OSI_CS_API_PORT=0; fi
exec '${process.execPath}' "$@"`);
  exe('id', 'echo "${TEST_UID:-0}"');
  exe('sleep', '[ "$1" != 10 ] || [ "${TEST_LATE_DEATH:-0}" != 1 ] || rm -f "$OSI_CS_ROOT/running"');
  exe('date', 'if [ "$1" = +%s ]; then n=$(cat "$OSI_CS_ROOT/clock" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$OSI_CS_ROOT/clock"; echo "$n"; else exec /usr/bin/date "$@"; fi');
  exe('df', 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "test 100000 0 ${TEST_FREE_KB:-100000} 0% /srv"');
  fs.writeFileSync(p('service'), `#!/bin/sh
set -eu
case "$1" in
stop)
  [ "\${TEST_STOP_STUCK:-0}" != 1 ] || exit 0
  rm -f "$OSI_CS_ROOT/running" ;;
start)
  if grep -q pragmas "$OSI_CS_ROOT/etc/init.d/chirpstack"; then
    [ "\${TEST_START_FAIL:-0}" != 1 ] || exit 1
    if [ "\${TEST_NO_WAL:-0}" != 1 ]; then
      node -e 'const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.env.OSI_CS_ROOT+"/srv/chirpstack/chirpstack.sqlite"); d.exec("PRAGMA journal_mode=WAL; INSERT INTO uplinks VALUES (2)"); d.close()'
    fi
  fi
  sed "s|/var/etc/|$OSI_CS_ROOT/var/etc/|g" "$OSI_CS_ROOT/etc/init.d/chirpstack" > "$OSI_CS_ROOT/rendered-init"
  . "$OSI_CS_ROOT/rendered-init"
  config_load() { :; }
  config_foreach() { :; }
  configuration
  [ "\${TEST_BAD_CONFIG:-0}" != 1 ] || echo bad > "$OSI_CS_ROOT/var/etc/chirpstack/chirpstack.toml"
  echo chirpstack > "$OSI_CS_ROOT/running" ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${p('bin')}:${path.dirname(process.execPath)}:${process.env.PATH}`, OSI_CS_ROOT: root, OSI_CS_SQLITE_MODULE: 'node:sqlite', OSI_CS_SERVICE: p('service'), OSI_CS_API_PORT: String(server.address().port), NODE_NO_WARNINGS: '1' };
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const run = (args = [], extra = {}) => spawnSync(shell, [...shellArgs, script, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 });
  const state = () => Object.fromEntries(['etc/init.d/chirpstack', 'opt/chirpstack/backup.sh', 'opt/chirpstack/restore.sh', 'srv/chirpstack/chirpstack.sqlite'].map((f) => [f, [hash(p(f)), fs.statSync(p(f)).mtimeMs, fs.statSync(p(f)).mode]]));
  const journal = () => [...fs.readFileSync(p('srv/chirpstack/chirpstack.sqlite')).subarray(18, 20)];
  const backup = () => p(`srv/backup/${fs.readdirSync(p('srv/backup'))[0]}`);
  return { root, p, run, state, journal, backup, env };
}
function ok(r, status = 0) { assert.equal(r.status, status, `${r.error || ''}\n${r.stdout}\n${r.stderr}`); }
function restored(g) {
  assert.equal(fs.readFileSync(g.p('etc/init.d/chirpstack'), 'utf8'), original);
  assert.equal(fs.readFileSync(g.p('opt/chirpstack/backup.sh'), 'utf8'), '#!/bin/sh\necho old-backup\n');
  assert.equal(fs.readFileSync(g.p('opt/chirpstack/restore.sh'), 'utf8'), '#!/bin/sh\necho old-restore\n');
  assert.equal(fs.statSync(g.p('opt/chirpstack/restore.sh')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(g.p('opt/chirpstack/backup.sh')).mode & 0o777, 0o750);
  assert.deepEqual(g.journal(), [1, 1]);
  assert.ok(fs.existsSync(g.p('running')));
}

test(`field init converts with ${shell}, backup manifest and embedded #670 scripts`, async (t) => {
  const g = await gateway(t);
  const before = g.state();
  const check = g.run(); ok(check, 3); assert.match(check.stdout, /needs conversion/);
  assert.match(check.stdout, /init pragmas: no/); assert.match(check.stdout, /journal: DELETE/);
  assert.match(check.stdout, /running: yes/); assert.match(check.stdout, /backup\/restore WAL-aware: no/);
  assert.deepEqual(g.state(), before, 'check does not open SQLite or write');
  const applied = g.run(['--apply']); ok(applied); assert.match(applied.stdout, /OK: ChirpStack SQLite on WAL; backup/);
  assert.deepEqual(g.journal(), [2, 2]);
  assert.equal(fs.readFileSync(g.p('etc/init.d/chirpstack'), 'utf8'), converted);
  assert.equal(fs.statSync(g.p('etc/init.d/chirpstack')).mode & 0o777, 0o751);
  assert.equal(fs.readFileSync(path.join(g.backup(), 'chirpstack.init'), 'utf8'), original);
  assert.equal(fs.statSync(g.backup()).mode & 0o777, 0o700);
  const manifest = fs.readFileSync(path.join(g.backup(), 'MANIFEST.txt'), 'utf8');
  for (const file of ['chirpstack.sqlite', 'chirpstack.init', 'backup.sh', 'restore.sh']) assert.ok(manifest.includes(`${hash(path.join(g.backup(), file))}  ${file}\n`));
  for (const file of ['backup.sh', 'restore.sh']) assert.deepEqual(fs.readFileSync(g.p(`opt/chirpstack/${file}`)), fs.readFileSync(path.join(fixtures, 'feed-670', file)));
  ok(g.run(['--check']));
  const once = g.state(); const backupNames = fs.readdirSync(g.p('srv/backup'));
  const twice = g.run(['--apply']); ok(twice); assert.match(twice.stdout, /OK: already WAL/);
  assert.deepEqual(g.state(), once); assert.deepEqual(fs.readdirSync(g.p('srv/backup')), backupNames);
});

test('streamed operator command reads its embedded helper without consuming script input', async (t) => {
  const g = await gateway(t);
  const r = spawnSync(shell, [...shellArgs, '-s', '--', '--apply'], { input: fs.readFileSync(script), env: g.env, encoding: 'utf8', timeout: 20000 });
  ok(r); assert.deepEqual(g.journal(), [2, 2]);
});

test('captured WAL fixture remains byte-identical on an idempotent apply', async (t) => {
  const wal = fs.readFileSync(path.join(fixtures, 'chirpstack.init.wal'), 'utf8');
  const g = await gateway(t, wal);
  const d = new DatabaseSync(g.p('srv/chirpstack/chirpstack.sqlite')); d.exec('PRAGMA journal_mode=WAL'); d.close();
  const before = g.state(); ok(g.run(['--apply'])); assert.deepEqual(g.state(), before);
});

for (const [name, init, env] of [
  ['no anchor', original.replace('\t\tpath=', '\tpath='), {}],
  ['two anchors', original.replace('\t\tpath="/srv/chirpstack/chirpstack.sqlite"', '\t\tpath="/srv/chirpstack/chirpstack.sqlite"\n\t\tpath="/srv/chirpstack/chirpstack.sqlite"'), {}],
  ['existing non-WAL pragmas', original.replace('\t\t[sqlite]', '\t\t[sqlite]\n\t\tpragmas = ["journal_mode = DELETE"]'), {}],
  ['pragmas present but header is DELETE', converted, {}],
  ['wrong heredoc delimiter', original.replace('<<- EOF', '<<- OTHER'), {}],
  ['anchor outside configuration', original.replace('configuration() {', 'something_else() {'), {}],
  ['not root', original, { TEST_UID: '1000' }],
  ['too little space', original, { TEST_FREE_KB: '0' }],
  ['service will not stop', original, { TEST_STOP_STUCK: '1' }],
]) test(`refusal: ${name} changes no runtime bytes`, async (t) => {
  const g = await gateway(t, init); const before = g.state(); const r = g.run(['--apply'], env);
  ok(r, 1); assert.match(r.stderr, /ERROR:/); assert.deepEqual(g.state(), before);
});

for (const [name, target, extra] of [
  ['init missing', 'etc/init.d/chirpstack', {}],
  ['database missing', 'srv/chirpstack/chirpstack.sqlite', {}],
  ['sqlite module missing', null, { OSI_CS_SQLITE_MODULE: '/nonexistent/sqlite3' }],
]) test(`precondition: ${name} refuses before stopping`, async (t) => {
  const g = await gateway(t);
  if (target) fs.unlinkSync(g.p(target));
  const marker = fs.statSync(g.p('running')).mtimeMs;
  ok(g.run(['--apply'], extra), 1);
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
  const before = g.state(); const r = g.run(['--apply']); ok(r, 1); assert.match(r.stderr, /integrity/);
  assert.deepEqual(g.state(), before); assert.ok(fs.existsSync(g.p('running')));
});

for (const [name, extra] of [
  ['start fails', { TEST_START_FAIL: '1' }],
  ['header never switches', { TEST_NO_WAL: '1' }],
  ['API port unavailable', { TEST_BAD_PORT: '1' }],
  ['generated config lacks pragmas', { TEST_BAD_CONFIG: '1' }],
  ['dies during the ten-second wait', { TEST_LATE_DEATH: '1' }],
]) test(`automatic rollback: ${name}`, async (t) => {
  const g = await gateway(t); const r = g.run(['--apply'], extra);
  ok(r, 1); assert.match(r.stderr, /ROLLED BACK:/); restored(g);
  if (extra.TEST_BAD_CONFIG || extra.TEST_LATE_DEATH) {
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
  const before = g.state(); ok(g.run(['--rollback', g.backup()]), 1); assert.deepEqual(g.state(), before);
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
