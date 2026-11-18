'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const repo = path.resolve(__dirname, '..');
const feed = path.join(repo, 'feeds/chirpstack-openwrt-feed/chirpstack/chirpstack/files');
const find = (name) => (process.env.PATH || '').split(path.delimiter).map(d => path.join(d, name)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
});
const shells = [];
if (find('busybox')) shells.push([find('busybox'), ['ash']]);
if (find('dash')) shells.push([find('dash'), []]);
if (!shells.length && process.env.OSI_CS_TEST_SHELL) shells.push([process.env.OSI_CS_TEST_SHELL, []]);
assert.ok(shells.length, 'install busybox/dash or set OSI_CS_TEST_SHELL');
if (process.env.CI) assert.equal(shells.length, 2, 'CI must exercise BusyBox ash and dash');
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const names = ['chirpstack.sqlite', 'chirpstack.sqlite-wal', 'chirpstack.sqlite-shm', 'chirpstack.redis'];
for (const [shell, args] of shells) {
  function gateway(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-cs-backup-'));
    const p = f => path.join(root, f);
    for (const d of ['bin', 'srv/chirpstack', 'srv/redis', 'srv/backup']) fs.mkdirSync(p(d), { recursive: true });
    const live = n => p(n === 'chirpstack.redis' ? 'srv/redis/dump.rdb' : `srv/chirpstack/${n}`);
    const db = new DatabaseSync(live('chirpstack.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE uplinks (id INTEGER); INSERT INTO uplinks VALUES (1)');
    const snapshot = names.slice(0, 3).map(n => [n, fs.readFileSync(live(n))]);
    db.close();
    for (const [n, bytes] of snapshot) fs.writeFileSync(live(n), bytes);
    fs.writeFileSync(live('chirpstack.redis'), 'live-redis');
    for (const s of ['chirpstack', 'redis']) fs.writeFileSync(p(`${s}.running`), 'yes');
    const exe = (name, body) => fs.writeFileSync(p(`bin/${name}`), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    // A restricted PATH makes CLI absence deterministic, even on CI hosts with sqlite3.
    for (const cmd of ['cp', 'mv', 'rm', 'mkdir', 'rmdir', 'mktemp', 'chmod', 'date', 'sha256sum', 'cat']) {
      const target = find(cmd); assert.ok(target, cmd); fs.symlinkSync(target, p(`bin/${cmd}`));
    }
    exe('service', `echo "$*" >> "$OSI_CS_ROOT/calls"
case "$2" in
stop) [ "\${STOP_STUCK:-}" != "$1" ] || exit 0
      [ "\${STOP_ERROR:-}" != "$1" ] || exit 1
      rm -f "$OSI_CS_ROOT/$1.running" ;;
start) [ "\${START_FAIL:-}" != "$1" ] || exit 1
       if [ "\${START_FAIL_ONCE:-}" = "$1" ] && [ ! -f "$OSI_CS_ROOT/start-failed" ]; then
         echo yes > "$OSI_CS_ROOT/$1.running"
         echo yes > "$OSI_CS_ROOT/start-failed"
         exit 1
       fi
       echo yes > "$OSI_CS_ROOT/$1.running" ;;
esac`);
    exe('pidof', `case "$1" in redis-server) s=redis;; *) s=$1;; esac
[ -f "$OSI_CS_ROOT/$s.running" ] || exit 1
echo 123`);
    exe('sleep', 'echo wait >> "$OSI_CS_ROOT/waits"');
    exe('sqlite3', `echo "$*" >> "$OSI_CS_ROOT/sqlite-calls"
[ "\${BAD_INTEGRITY:-0}" != 1 ] || { echo corrupt; exit 0; }
# Opening WAL may checkpoint and remove sidecars: only disposable copies may change.
[ "\${SQLITE_MUTATE:-0}" != 1 ] || { echo checkpoint >> "$1"; rm -f "$1-wal" "$1-shm"; }
echo ok`);
    fs.unlinkSync(p('bin/cp'));
    exe('cp', `[ -z "\${FAIL_COPY:-}" ] || case "$*" in *"$FAIL_COPY"*) echo injected-copy-failure >&2; exit 1;; esac
exec '${find('cp')}' "$@"`);
    fs.unlinkSync(p('bin/mv'));
    exe('mv', `[ -z "\${FAIL_MOVE:-}" ] || case "$*" in *"$FAIL_MOVE"*) exit 1;; esac
exec '${find('mv')}' "$@"`);
    const run = (file, env = {}) => spawnSync(shell, [...args, path.join(feed, file + '.sh')], {
      env: { ...process.env, PATH: p('bin'), OSI_CS_ROOT: root, ...env }, encoding: 'utf8', timeout: 10000
    });
    const state = () => Object.fromEntries(names.map(n => [n, [fs.readFileSync(live(n)).toString('base64'), fs.statSync(live(n)).mtimeMs]]));
    const running = () => { for (const s of ['chirpstack', 'redis']) assert.ok(fs.existsSync(p(`${s}.running`)), `${s} running`); };
    const backup = (legacy = false, sidecars = true) => {
      const dir = p(legacy ? 'srv/backup' : 'srv/backup/chirpstack-set');
      fs.mkdirSync(dir, { recursive: true });
      for (const n of names) if (sidecars || !/-wal|-shm/.test(n)) fs.writeFileSync(path.join(dir, n), `saved-${n}`);
      if (!legacy) manifest(dir);
      return dir;
    };
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { p, live, run, state, running, backup };
  }
  function manifest(dir) {
    fs.writeFileSync(path.join(dir, 'MANIFEST.sha256'), names.filter(n => fs.existsSync(path.join(dir, n))).map(n => `${digest(fs.readFileSync(path.join(dir, n)))}  ${n}\n`).join(''));
  }
  const ok = r => assert.equal(r.status, 0, `${r.error || ''}\n${r.stdout}\n${r.stderr}`);
  const bad = r => { assert.notEqual(r.status, null, String(r.error)); assert.notEqual(r.status, 0, r.stdout); assert.match(r.stdout + r.stderr, /ERROR: .*; ChirpStack (running|not running)/); };
  const label = path.basename(shell);
  test(`${label}: POSIX syntax`, () => { for (const n of ['backup', 'restore']) ok(spawnSync(shell, [...args, '-n', path.join(feed, n + '.sh')], { encoding: 'utf8' })); });
  for (const cli of [true, false]) test(`${label}: backup happy path, sqlite CLI ${cli}`, t => {
    const g = gateway(t); const before = g.state();
    if (!cli) fs.unlinkSync(g.p('bin/sqlite3'));
    ok(g.run('backup', { SQLITE_MUTATE: '1' })); g.running();
    const dir = g.p('srv/backup/chirpstack-set');
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    for (const n of names) assert.equal(fs.readFileSync(path.join(dir, n)).toString('base64'), before[n][0]);
    assert.deepEqual(g.state(), before); assert.ok(fs.existsSync(path.join(dir, 'MANIFEST.sha256')));
    assert.equal(fs.existsSync(g.p('sqlite-calls')), cli);
    assert.match(g.run('backup').stdout, /OK: backup .*chirpstack-set/);
    assert.ok(fs.existsSync(g.p('srv/backup/chirpstack-set.prev')));
  });
  test(`${label}: real WAL integrity includes committed rows from sidecars`, t => {
    const g = gateway(t);
    fs.writeFileSync(g.p('bin/sqlite3'), `#!${process.execPath}
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync(process.argv[2]);
if (d.prepare('SELECT count(*) AS n FROM uplinks').get().n !== 1) process.exit(2);
console.log(d.prepare('PRAGMA integrity_check').get().integrity_check);
d.close();
`, { mode: 0o755 });
    ok(g.run('backup')); g.running();
  });
  for (const service of ['chirpstack', 'redis']) test(`${label}: ${service} stop command failure copies nothing`, t => {
    const g = gateway(t); const before = g.state();
    bad(g.run('backup', { STOP_ERROR: service })); assert.deepEqual(g.state(), before); g.running();
    assert.deepEqual(fs.readdirSync(g.p('srv/backup')), []);
  });
  for (const service of ['chirpstack', 'redis']) for (const op of ['backup', 'restore']) test(`${label}: ${op}, ${service} refuses stop`, t => {
    const g = gateway(t); const before = g.state(); if (op === 'restore') g.backup();
    bad(g.run(op, { STOP_STUCK: service })); g.running(); assert.deepEqual(g.state(), before);
    assert.equal(fs.readFileSync(g.p('waits'), 'utf8').trim().split('\n').length, 30);
    if (op === 'backup') assert.deepEqual(fs.readdirSync(g.p('srv/backup')), []);
    assert.ok(!fs.readdirSync(g.p('srv/chirpstack')).some(n => n.includes('pre-restore')));
  });
  test(`${label}: backup copy fails, previous publication retained and temporary set removed`, t => {
    const g = gateway(t); const dir = g.backup(); const before = fs.readFileSync(path.join(dir, 'MANIFEST.sha256'));
    bad(g.run('backup', { FAIL_COPY: 'dump.rdb' })); g.running();
    assert.deepEqual(fs.readFileSync(path.join(dir, 'MANIFEST.sha256')), before);
    assert.deepEqual(fs.readdirSync(g.p('srv/backup')), ['chirpstack-set']);
  });
  for (const defect of ['missing', 'dump missing', 'hash mismatch', 'extra file', 'missing manifest', 'duplicate entry', 'integrity']) test(`${label}: restore rejects ${defect} before changing live files`, t => {
    const g = gateway(t); const before = g.state();
    if (defect !== 'missing') {
      const dir = g.backup();
      if (defect === 'dump missing') fs.unlinkSync(path.join(dir, 'chirpstack.redis'));
      if (defect === 'hash mismatch') fs.appendFileSync(path.join(dir, names[0]), 'bad');
      if (defect === 'extra file') fs.writeFileSync(path.join(dir, '.unexpected'), 'bad');
      if (defect === 'missing manifest') fs.unlinkSync(path.join(dir, 'MANIFEST.sha256'));
      if (defect === 'duplicate entry') fs.appendFileSync(path.join(dir, 'MANIFEST.sha256'), fs.readFileSync(path.join(dir, 'MANIFEST.sha256')));
    }
    bad(g.run('restore', { BAD_INTEGRITY: defect === 'integrity' ? '1' : '0' }));
    assert.deepEqual(g.state(), before); g.running();
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /stop/);
  });
  for (const fail of ['srv/chirpstack/chirpstack.sqlite', 'srv/redis/dump.rdb']) test(`${label}: interrupted restore rolls back ${fail}`, t => {
    const g = gateway(t); g.backup(); const before = g.state();
    const r = g.run('restore', { FAIL_COPY: fail }); bad(r); assert.match(r.stdout + r.stderr, /ROLLED BACK:/);
    assert.deepEqual(g.state(), before); g.running();
  });
  test(`${label}: failed publication restores previous set`, t => {
    const g = gateway(t); const dir = g.backup(); const before = fs.readFileSync(path.join(dir, 'MANIFEST.sha256'));
    bad(g.run('backup', { FAIL_MOVE: '.chirpstack-stage.' })); g.running();
    assert.deepEqual(fs.readFileSync(path.join(dir, 'MANIFEST.sha256')), before);
    assert.deepEqual(fs.readdirSync(g.p('srv/backup')), ['chirpstack-set']);
  });
  test(`${label}: failed move restores files already moved`, t => {
    const g = gateway(t); g.backup(); const before = g.state();
    const r = g.run('restore', { FAIL_MOVE: 'chirpstack.sqlite-wal' }); bad(r);
    assert.match(r.stdout, /ROLLED BACK:/); assert.deepEqual(g.state(), before); g.running();
  });
  for (const service of ['chirpstack', 'redis']) test(`${label}: failed ${service} start rolls back even if a writer spawned`, t => {
    const g = gateway(t); g.backup(); const before = g.state();
    const r = g.run('restore', { START_FAIL_ONCE: service }); bad(r);
    assert.match(r.stdout, /ROLLED BACK:/); assert.deepEqual(g.state(), before); g.running();
  });
  test(`${label}: process-probe errors fail closed`, t => {
    const g = gateway(t); const before = g.state();
    fs.writeFileSync(g.p('bin/pidof'), '#!/bin/sh\nexit 2\n');
    bad(g.run('backup')); assert.deepEqual(g.state(), before);
    assert.deepEqual(fs.readdirSync(g.p('srv/backup')), []);
  });
  test(`${label}: pgrep fallback uses exact process names`, t => {
    const g = gateway(t); fs.renameSync(g.p('bin/pidof'), g.p('bin/probe'));
    fs.writeFileSync(g.p('bin/pgrep'), '#!/bin/sh\n[ "$1" = -x ] || exit 2\nshift\nexec "$OSI_CS_ROOT/bin/probe" "$@"\n', { mode: 0o755 });
    ok(g.run('backup')); g.running();
  });
  test(`${label}: legacy missing Redis dump leaves live files untouched`, t => {
    const g = gateway(t); const dir = g.backup(true); fs.unlinkSync(path.join(dir, 'chirpstack.redis'));
    const before = g.state(); bad(g.run('restore')); assert.deepEqual(g.state(), before); g.running();
  });
  for (const legacy of [false, true]) for (const sidecars of [false, true]) test(`${label}: restore happy path legacy=${legacy}, sidecars=${sidecars}`, t => {
    const g = gateway(t); g.backup(legacy, sidecars); const before = g.state();
    const r = g.run('restore', { SQLITE_MUTATE: '1' }); ok(r); assert.match(r.stdout, /OK: restored from/); g.running();
    for (const n of names) {
      if (sidecars || !/-wal|-shm/.test(n)) assert.equal(fs.readFileSync(g.live(n), 'utf8'), `saved-${n}`);
      else assert.equal(fs.existsSync(g.live(n)), false);
      const dir = path.dirname(g.live(n)); const base = path.basename(g.live(n));
      const saved = fs.readdirSync(dir).find(f => f.startsWith(`${base}.pre-restore-`));
      assert.ok(saved); assert.equal(fs.readFileSync(path.join(dir, saved)).toString('base64'), before[n][0]);
    }
  });
}
