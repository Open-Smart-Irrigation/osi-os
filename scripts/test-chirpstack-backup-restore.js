'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
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
  function gateway(t, prefix = 'osi-cs-backup-') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
[ "\${EXPECT_JOURNAL:-0}" != 1 ] || [ -f "$1-journal" ] || exit 1
[ "\${BAD_INTEGRITY:-0}" != 1 ] || { echo corrupt; exit 0; }
# Opening WAL may checkpoint and remove sidecars: only disposable copies may change.
[ "\${SQLITE_MUTATE:-0}" != 1 ] || { echo checkpoint >> "$1"; rm -f "$1-wal" "$1-shm"; }
echo ok`);
    fs.unlinkSync(p('bin/cp'));
    exe('cp', `[ -z "\${FAIL_OPERATOR_FILE:-}" ] || case "$*" in *"/$FAIL_OPERATOR_FILE"*) exit 1;; esac
if [ -n "\${PAUSE_COPY:-}" ]; then
  case "$*" in *"$PAUSE_COPY"*)
    echo paused > "$OSI_CS_ROOT/copy-paused"
    while [ ! -f "$OSI_CS_ROOT/copy-resume" ]; do '${find('sleep')}' 0.01; done ;;
  esac
fi
case "$1" in -p) source=$2;; *) source=$1;; esac
case "$source" in *.pre-restore-*) exec '${find('cp')}' "$@";; esac
[ "\${FAIL_COPY_AFTER:-0}" != 1 ] || '${find('cp')}' "$@"
[ -z "\${FAIL_COPY:-}" ] || case "$*" in *"$FAIL_COPY"*) echo injected-copy-failure >&2; exit 1;; esac
exec '${find('cp')}' "$@"`);
    fs.unlinkSync(p('bin/mv'));
    exe('mv', `[ -z "\${FAIL_OPERATOR_FILE:-}" ] || case "$*" in *"/$FAIL_OPERATOR_FILE"*) exit 1;; esac
if [ -n "\${FAIL_ROLLBACK_MOVE:-}" ]; then
  case "$1" in *"/$FAIL_ROLLBACK_MOVE.pre-restore-"*) echo injected-rollback-rename >&2; exit 1;; esac
fi
[ -z "\${FAIL_MOVE:-}" ] || case "$*" in *"$FAIL_MOVE"*) exit 1;; esac
exec '${find('mv')}' "$@"`);
    fs.unlinkSync(p('bin/rm'));
    exe('rm', `[ -z "\${FAIL_REMOVE:-}" ] || case "$*" in *"/$FAIL_REMOVE") echo injected-rollback-removal >&2; exit 1;; esac
exec '${find('rm')}' "$@"`);
    fs.unlinkSync(p('bin/rmdir'));
    exe('rmdir', `'${find('rmdir')}' "$@" || exit 1
if [ "\${RACE_UNLOCK:-0}" = 1 ] && [ ! -f "$OSI_CS_ROOT/raced" ]; then
  echo yes > "$OSI_CS_ROOT/raced"
  (RACE_UNLOCK=0 PAUSE_COPY=srv/redis/dump.rdb '${shell}' ${args.join(' ')} '${path.join(feed, 'restore.sh')}' > "$OSI_CS_ROOT/contender-log" 2>&1; echo done > "$OSI_CS_ROOT/contender-done") &
  while [ ! -f "$OSI_CS_ROOT/copy-paused" ]; do '${find('sleep')}' 0.01; done
fi`);
    const environment = extra => ({ ...process.env, PATH: p('bin'), OSI_CS_ROOT: root, ...extra });
    const run = (file, env = {}) => spawnSync(shell, [...args, path.join(feed, file + '.sh')], {
      env: environment(env), encoding: 'utf8', timeout: 10000
    });
    const owner = (file, env) => {
      const child = spawn(shell, [...args, path.join(feed, file + '.sh')], { env: environment(env) });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
      const finished = new Promise((resolve, reject) => {
        child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
      });
      return { child, finished };
    };
    const commands = (text, extra = {}) => spawnSync(shell, [...args, '-c', text], { env: environment(extra), encoding: 'utf8', timeout: 10000 });
    const commandAsync = text => {
      const child = spawn(shell, [...args, '-c', text], { env: environment({ RACE_UNLOCK: '1' }), stdio: 'ignore' });
      return new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', status => resolve({ status })); });
    };
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
    return { p, live, run, state, running, backup, owner, commands, commandAsync };
  }
  function manifest(dir) {
    fs.writeFileSync(path.join(dir, 'MANIFEST.sha256'), [...names, 'chirpstack.sqlite-journal'].filter(n => fs.existsSync(path.join(dir, n))).map(n => `${digest(fs.readFileSync(path.join(dir, n)))}  ${n}\n`).join(''));
  }
  const ok = r => { assert.ifError(r.error); assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); };
  const bad = r => { assert.ifError(r.error); assert.notEqual(r.status, null, String(r.error)); assert.notEqual(r.status, 0, r.stdout); assert.match(r.stdout + r.stderr, /ERROR: .*; ChirpStack (running|not running)/); };
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
  for (const ownerOp of ['backup', 'restore']) for (const contenderOp of ['backup', 'restore']) {
    test(`${label}: lock contender ${contenderOp} cannot restart concurrent ${ownerOp} owner`, async t => {
      const g = gateway(t); if (ownerOp === 'restore') g.backup();
      const owner = g.owner(ownerOp, { PAUSE_COPY: ownerOp === 'backup' ? 'srv/chirpstack/chirpstack.sqlite' : 'srv/redis/dump.rdb' });
      const deadline = Date.now() + 5000;
      try {
        while (!fs.existsSync(g.p('copy-paused'))) {
          assert.ok(Date.now() < deadline, 'owner reached pause after stopping both services');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const calls = fs.readFileSync(g.p('calls'), 'utf8');
        const files = () => names.map(n => fs.existsSync(g.live(n)) ? fs.readFileSync(g.live(n)).toString('base64') : null);
        const before = files();
        const contender = g.run(contenderOp); bad(contender);
        assert.equal(fs.readFileSync(g.p('calls'), 'utf8'), calls, 'contender makes no service call');
        for (const service of ['chirpstack', 'redis']) assert.equal(fs.existsSync(g.p(`${service}.running`)), false);
        assert.deepEqual(files(), before);
        assert.ok(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')));
      } finally {
        fs.writeFileSync(g.p('copy-resume'), 'yes');
        const timer = setTimeout(() => owner.child.kill('SIGKILL'), 5000);
        try { ok(await owner.finished); } finally { clearTimeout(timer); }
      }
      g.running();
    });
  }
  for (const target of ['chirpstack.sqlite', 'chirpstack.sqlite-wal', 'dump.rdb']) {
    test(`${label}: incomplete rollback rename for ${target} retains originals and prevents starts`, t => {
      const g = gateway(t, target === 'chirpstack.sqlite-wal' ? "osi-cs-backup-quote' -" : undefined); g.backup(); const before = g.state();
      const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_COPY_AFTER: '1', FAIL_ROLLBACK_MOVE: target });
      bad(r); assert.match(r.stdout + r.stderr, /ERROR: ROLLBACK INCOMPLETE/);
      assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
      for (const service of ['chirpstack', 'redis']) assert.equal(fs.existsSync(g.p(`${service}.running`)), false);
      for (const name of names) {
        const dir = path.dirname(g.live(name)), base = path.basename(g.live(name));
        const saved = fs.readdirSync(dir).filter(n => n.startsWith(base + '.pre-restore-') && !n.endsWith('.pending'));
        assert.equal(saved.length, 1, name + ' original retained');
        const original = path.join(dir, saved[0]);
        assert.equal(fs.readFileSync(original).toString('base64'), before[name][0]);
        assert.ok((r.stdout + r.stderr).includes(original), 'report names original path');
        assert.ok((r.stdout + r.stderr).includes(g.live(name)), 'report names live path');
      }
      const targetName = target === 'dump.rdb' ? 'chirpstack.redis' : target;
      assert.equal(fs.readFileSync(g.live(targetName), 'utf8'), `saved-${targetName}`, 'failed rename keeps replacement slot');
      assert.ok(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), 'incomplete recovery retains lock');
      const contender = g.run('backup'); bad(contender);
      assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
      const commands = /BEGIN RECOVERY COMMANDS\n([^]*?)END RECOVERY COMMANDS/.exec(r.stdout + r.stderr);
      assert.ok(commands, 'exact recovery commands provided');
      ok(g.commands(commands[1]));
      assert.deepEqual(g.state(), before); g.running();
    });
  }
  test(`${label}: failed removal of an originally absent sidecar prevents restart`, t => {
    const g = gateway(t); g.backup();
    for (const n of names.slice(1, 3)) fs.unlinkSync(g.live(n));
    const main = fs.readFileSync(g.live('chirpstack.sqlite'));
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_REMOVE: 'chirpstack.sqlite-wal' });
    bad(r); assert.match(r.stdout + r.stderr, /ERROR: ROLLBACK INCOMPLETE/);
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
    assert.deepEqual(fs.readFileSync(g.live('chirpstack.sqlite')), main);
    for (const service of ['chirpstack', 'redis']) assert.equal(fs.existsSync(g.p(`${service}.running`)), false);
    for (const name of ['chirpstack.sqlite', 'chirpstack.redis']) {
      assert.ok(fs.readdirSync(path.dirname(g.live(name))).some(n => n.startsWith(path.basename(g.live(name)) + '.pre-restore-')));
    }
    const commands = /BEGIN RECOVERY COMMANDS\n([^]*?)END RECOVERY COMMANDS/.exec(r.stdout + r.stderr);
    assert.ok(commands); ok(g.commands(commands[1])); g.running();
    assert.equal(fs.existsSync(g.live('chirpstack.sqlite-wal')), false);
  });
  test(`${label}: journal backup includes copied rollback journal in integrity and manifest`, t => {
    const g = gateway(t); fs.writeFileSync(g.live('chirpstack.sqlite-journal'), 'hot-journal');
    ok(g.run('backup', { EXPECT_JOURNAL: '1' }));
    assert.equal(fs.readFileSync(g.p('srv/backup/chirpstack-set/chirpstack.sqlite-journal'), 'utf8'), 'hot-journal');
    assert.match(fs.readFileSync(g.p('srv/backup/chirpstack-set/MANIFEST.sha256'), 'utf8'), /chirpstack.sqlite-journal/);
  });
  for (const savedJournal of [false, true]) test(`${label}: journal restore replaces stale live journal, saved=${savedJournal}`, t => {
    const g = gateway(t); const dir = g.backup();
    fs.writeFileSync(g.live('chirpstack.sqlite-journal'), 'old-journal');
    if (savedJournal) { fs.writeFileSync(path.join(dir, 'chirpstack.sqlite-journal'), 'saved-journal'); manifest(dir); }
    ok(g.run('restore'));
    if (savedJournal) assert.equal(fs.readFileSync(g.live('chirpstack.sqlite-journal'), 'utf8'), 'saved-journal');
    else assert.equal(fs.existsSync(g.live('chirpstack.sqlite-journal')), false);
    const saved = fs.readdirSync(path.dirname(g.live('chirpstack.sqlite-journal'))).find(n => n.startsWith('chirpstack.sqlite-journal.pre-restore-'));
    assert.ok(saved); assert.equal(fs.readFileSync(g.p('srv/chirpstack/' + saved), 'utf8'), 'old-journal');
  });
  test(`${label}: journal rolls back with all originals`, t => {
    const g = gateway(t); g.backup(); fs.writeFileSync(g.live('chirpstack.sqlite-journal'), 'old-journal');
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb' }); bad(r); assert.match(r.stdout, /ROLLED BACK:/);
    assert.equal(fs.readFileSync(g.live('chirpstack.sqlite-journal'), 'utf8'), 'old-journal');
    assert.ok(fs.readdirSync(g.p('srv/chirpstack')).some(n => n.startsWith('chirpstack.sqlite-journal.pre-restore-')));
  });
  test(`${label}: recovery commands resume after partial failure and can run twice`, t => {
    const g = gateway(t); g.backup(); const before = g.state();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    const commands = /BEGIN RECOVERY COMMANDS\n([^]*?)END RECOVERY COMMANDS/.exec(r.stdout + r.stderr)[1];
    const first = g.commands(commands, { FAIL_OPERATOR_FILE: 'chirpstack.sqlite-wal' }); assert.notEqual(first.status, 0);
    for (const n of names) assert.ok(fs.readdirSync(path.dirname(g.live(n))).some(f => f.startsWith(path.basename(g.live(n)) + '.pre-restore-')));
    ok(g.commands(commands)); assert.deepEqual(g.state(), before);
    ok(g.commands(commands)); assert.deepEqual(g.state(), before); g.running();
  });
  test(`${label}: recovery restart failure retains the lock and says why`, t => {
    const g = gateway(t); g.backup();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    const commands = /BEGIN RECOVERY COMMANDS\n([^]*?)END RECOVERY COMMANDS/.exec(r.stdout + r.stderr)[1];
    const failed = g.commands(commands, { START_FAIL: 'redis' }); assert.notEqual(failed.status, 0);
    assert.ok(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')));
    assert.match(failed.stdout + failed.stderr, /ERROR: .*restart.*lock retained/i);
    ok(g.commands(commands)); g.running();
  });
  test(`${label}: recovery unlocks only after checked starts, concurrent restore stays quiescent`, async t => {
    const g = gateway(t); g.backup();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    const commands = /BEGIN RECOVERY COMMANDS\n([^]*?)END RECOVERY COMMANDS/.exec(r.stdout + r.stderr)[1];
    try {
      ok(await g.commandAsync(commands));
      assert.ok(fs.existsSync(g.p('copy-paused')), 'contender has moved live files and paused');
      assert.equal(fs.existsSync(g.live('chirpstack.redis')), false);
      for (const s of ['chirpstack', 'redis']) assert.equal(fs.existsSync(g.p(s + '.running')), false, 'operator did not restart contender services');
    } finally {
      fs.writeFileSync(g.p('copy-resume'), 'yes');
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(g.p('contender-done'))) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); }
    }
    g.running();
  });
  test(`${label}: retention reports current originals and prunes old generations only after success`, t => {
    const g = gateway(t); g.backup();
    const first = g.run('restore'); ok(first);
    const old = names.map(n => path.join(path.dirname(g.live(n)), fs.readdirSync(path.dirname(g.live(n))).find(f => f.startsWith(path.basename(g.live(n)) + '.pre-restore-'))));
    for (const p of old) assert.ok(first.stdout.includes(p), 'success names every original');
    ok(g.run('restore'));
    for (const p of old) assert.equal(fs.existsSync(p), false, 'older generation removed');
    const kept = names.map(n => fs.readdirSync(path.dirname(g.live(n))).filter(f => f.startsWith(path.basename(g.live(n)) + '.pre-restore-')));
    assert.ok(kept.every(generation => generation.length === 1));
    const beforeFailure = names.flatMap(n => fs.readdirSync(path.dirname(g.live(n))).filter(f => f.startsWith(path.basename(g.live(n)) + '.pre-restore-')).map(f => path.join(path.dirname(g.live(n)), f)));
    const failed = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(failed);
    for (const p of beforeFailure) assert.ok(fs.existsSync(p), 'incomplete recovery never prunes');
  });
  test(`${label}: failed publication returns archived flat files without changing the old set`, t => {
    const g = gateway(t); const dir = g.backup(); const old = fs.readFileSync(path.join(dir, 'MANIFEST.sha256'));
    g.backup(true);
    const r = g.run('backup', { FAIL_MOVE: '.chirpstack-stage.' }); bad(r);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'MANIFEST.sha256')), old);
    for (const n of names) assert.equal(fs.readFileSync(g.p('srv/backup/' + n), 'utf8'), `saved-${n}`);
    assert.equal(fs.readdirSync(g.p('srv/backup')).some(n => n.startsWith('chirpstack-legacy-')), false);
    g.running();
  });
  for (const version of ['released', 'unreleased']) test(`${label}: archival prevents stale copies by ${version} stock helper`, t => {
    const g = gateway(t); g.backup(true);
    fs.writeFileSync(g.live('chirpstack.sqlite-journal'), 'live-journal');
    fs.writeFileSync(g.p('srv/backup/chirpstack.sqlite-journal'), 'saved-journal');
    const before = g.state();
    ok(g.run('backup'));
    for (const n of names) assert.equal(fs.existsSync(g.p('srv/backup/' + n)), false, 'flat file archived');
    const archive = fs.readdirSync(g.p('srv/backup')).find(n => n.startsWith('chirpstack-legacy-'));
    assert.ok(archive);
    assert.equal(fs.readFileSync(g.p(`srv/backup/${archive}/chirpstack.sqlite-journal`), 'utf8'), 'saved-journal');
    for (const n of names) assert.equal(fs.readFileSync(g.p(`srv/backup/${archive}/${n}`), 'utf8'), `saved-${n}`);
    const stock = fs.readFileSync(path.join(__dirname, 'fixtures/chirpstack-backup-restore/' + version + '-restore.sh'), 'utf8').replaceAll('/srv/', g.p('srv/'));
    const ran = g.commands(stock); assert.match(ran.stderr, /cannot stat|No such file/);
    assert.equal(fs.readFileSync(g.live('chirpstack.sqlite-journal'), 'utf8'), 'live-journal');
    assert.equal(fs.readFileSync(g.live('chirpstack.sqlite')).toString('base64'), before['chirpstack.sqlite'][0]);
    assert.equal(fs.readFileSync(g.live('chirpstack.redis')).toString('base64'), before['chirpstack.redis'][0]);
    if (version === 'released') assert.deepEqual(g.state(), before);
    else {
      // only #670's unreleased helper; fixed by this PR; no field gateway carries it
      assert.equal(ran.status, 0); // It ignores failed cp and still deletes live WAL/SHM.
      for (const n of ['chirpstack.sqlite-wal', 'chirpstack.sqlite-shm']) assert.equal(fs.existsSync(g.live(n)), false);
    }
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
