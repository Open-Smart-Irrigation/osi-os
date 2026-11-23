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
const busybox = find('busybox');
const busyboxApplets = busybox ? spawnSync(busybox, ['--list'], { encoding: 'utf8' }) : null;
const hasBusyboxFlock = busyboxApplets?.status === 0 && busyboxApplets.stdout.split('\n').includes('flock');
const flockCommand = hasBusyboxFlock ? `'${busybox}' flock` : `'${find('flock')}'`;
assert.ok(hasBusyboxFlock || find('flock'), 'install util-linux flock when BusyBox lacks the applet');
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
    exe('flock', `exec ${flockCommand} "$@"`);
    exe('service', `if [ "$2" = start ] && { [ ! -s "$OSI_CS_ROOT/srv/chirpstack/chirpstack.sqlite" ] || [ ! -s "$OSI_CS_ROOT/srv/redis/dump.rdb" ]; }; then
  echo "$*" >> "$OSI_CS_ROOT/unsafe-start"
fi
echo "$*" >> "$OSI_CS_ROOT/calls"
case "$2" in
stop) [ "\${STOP_STUCK:-}" != "$1" ] || exit 0
      [ "\${STOP_ERROR:-}" != "$1" ] || exit 1
      rm -f "$OSI_CS_ROOT/$1.running" ;;
start) if [ "\${PAUSE_START:-}" = "$1" ]; then
         echo paused > "$OSI_CS_ROOT/copy-paused"
         while [ ! -f "$OSI_CS_ROOT/copy-resume" ]; do '${find('sleep')}' 0.01; done
       fi
       [ "\${START_FAIL:-}" != "$1" ] || exit 1
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
    fs.unlinkSync(p('bin/mkdir'));
    exe('mkdir', `'${find('mkdir')}' "$@" || exit 1
if [ "\${SIGNAL_LOCK:-0}" = 1 ] && [ "$1" = "$OSI_CS_ROOT/srv/backup/.chirpstack-maintenance.lock" ]; then kill -TERM "$PPID"; fi`);
    fs.unlinkSync(p('bin/mktemp'));
    exe('mktemp', `[ "\${FAIL_STAGE:-0}" != 1 ] || exit 1
exec '${find('mktemp')}' "$@"`);
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
if [ "$1" = -f ]; then move_from=$2; move_to=$3; else move_from=$1; move_to=$2; fi
if [ -n "\${LIVE_MOVE_TARGET:-}" ] && [ "\${move_from##*/}" = "$LIVE_MOVE_TARGET" ]; then
  case "$move_to" in "$move_from.pre-restore-"*)
    case "$LIVE_MOVE_OUTCOME" in
      renamed) '${find('mv')}' "$@" || exit 2 ;;
      both) '${find('cp')}' -p "$move_from" "$move_to" || exit 2 ;;
      neither) '${find('mv')}' "$@" || exit 2; '${find('rm')}' -f "$move_to" || exit 2 ;;
      mismatch) '${find('mv')}' "$@" || exit 2; echo bad >> "$move_to" ;;
    esac
    exit 1 ;;
  esac
fi
if [ -n "\${RECOVERY_MOVE_OUTCOME:-}" ]; then
  case "$move_from" in *.pre-restore-*.pending)
    case "$RECOVERY_MOVE_OUTCOME" in
      renamed) '${find('mv')}' "$@" || exit 2 ;;
      both) '${find('cp')}' -p "$move_from" "$move_to" || exit 2 ;;
    esac
    exit 1 ;;
  esac
fi
if [ -n "\${FAIL_ROLLBACK_MOVE:-}" ]; then
  case "$1" in *"/$FAIL_ROLLBACK_MOVE.pre-restore-"*) echo injected-rollback-rename >&2; exit 1;; esac
fi
[ -z "\${FAIL_MOVE:-}" ] || case "$*" in *"$FAIL_MOVE"*) exit 1;; esac
if [ -n "\${ARCHIVE_ACTION:-}" ] && [ "$move_from" = "$OSI_CS_ROOT/srv/backup/chirpstack.sqlite" ]; then
  '${find('mv')}' "$@" || exit 2
  case "$ARCHIVE_ACTION" in TERM) kill -TERM "$PPID";; error) exit 1;; esac
  exit 0
fi
case "$1:$2" in
  "$OSI_CS_ROOT/srv/backup/.chirpstack-stage."*":$OSI_CS_ROOT/srv/backup/chirpstack-set")
    if [ -n "\${PUBLISH_ACTION:-}" ]; then
      [ "$PUBLISH_ACTION" != fail ] || exit 1
      '${find('mv')}' "$@" || exit 1
      case "$PUBLISH_ACTION" in
        TERM|HUP|INT) kill -"$PUBLISH_ACTION" "$PPID" ;;
        renamed-but-error) exit 1 ;;
      esac
      exit 0
    fi ;;
esac
exec '${find('mv')}' "$@"`);
    fs.unlinkSync(p('bin/rm'));
    exe('rm', `[ -z "\${FAIL_REMOVE:-}" ] || case "$*" in *"/$FAIL_REMOVE") echo injected-rollback-removal >&2; exit 1;; esac
exec '${find('rm')}' "$@"`);
    fs.unlinkSync(p('bin/rmdir'));
    exe('rmdir', `'${find('rmdir')}' "$@" || exit 1
if [ "\${RACE_UNLOCK:-0}" = 1 ] && [ ! -f "$OSI_CS_ROOT/raced" ]; then
  echo yes > "$OSI_CS_ROOT/raced"
  (RACE_UNLOCK=0 PAUSE_COPY=srv/redis/dump.rdb '${shell}' ${args.join(' ')} '${path.join(feed, 'restore.sh')}' > "$OSI_CS_ROOT/contender-log" 2>&1; echo done > "$OSI_CS_ROOT/contender-done") &
  race_wait=0
  while [ ! -f "$OSI_CS_ROOT/copy-paused" ]; do
    [ ! -f "$OSI_CS_ROOT/contender-done" ] || { echo 'ERROR: contender exited before pause' >&2; exit 1; }
    [ "$race_wait" -lt 300 ] || { echo 'ERROR: contender pause deadline' >&2; exit 1; }
    '${find('sleep')}' 0.01
    race_wait=$((race_wait + 1))
  done
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
    const commandAsync = (text, extra = {}, timeoutMs = 5000) => {
      const child = spawn(shell, [...args, '-c', text], { env: environment({ RACE_UNLOCK: '1', ...extra }), stdio: 'ignore', detached: true });
      const terminate = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      t.after(terminate);
      return new Promise((resolve, reject) => {
        let error;
        const timer = setTimeout(() => { error = new Error('asynchronous command deadline'); terminate(); }, timeoutMs);
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.on('close', status => { clearTimeout(timer); resolve({ status, error }); });
      });
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
    return { p, live, run, state, running, backup, owner, commands, commandAsync, environment };
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
    assert.equal(fs.existsSync(g.p('calls')), false, 'validation makes no service call');
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
    assert.ok(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock/recovery')), 'untrusted restart probe retains recovery state');
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
  for (const target of ['chirpstack.sqlite', 'chirpstack.sqlite-wal', 'chirpstack.sqlite-shm', 'chirpstack.sqlite-journal', 'dump.rdb']) {
    test(`${label}: reported live move failure after rename rolls back ${target}`, t => {
      const g = gateway(t); g.backup(); fs.writeFileSync(g.live('chirpstack.sqlite-journal'), 'original-journal');
      const before = g.state();
      const r = g.run('restore', { LIVE_MOVE_TARGET: target, LIVE_MOVE_OUTCOME: 'renamed' }); bad(r);
      assert.equal(fs.existsSync(g.p('unsafe-start')), false, 'no service starts on a missing live set');
      assert.match(r.stdout, /ROLLED BACK:/); assert.deepEqual(g.state(), before); g.running();
      assert.equal(fs.readFileSync(g.live('chirpstack.sqlite-journal'), 'utf8'), 'original-journal');
    });
  }
  for (const outcome of ['both', 'neither', 'mismatch']) test(`${label}: unclear live move ${outcome} retains recovery state and stops services`, t => {
    const g = gateway(t); g.backup(); const before = g.state();
    const r = g.run('restore', { LIVE_MOVE_TARGET: 'chirpstack.sqlite', LIVE_MOVE_OUTCOME: outcome }); bad(r);
    assert.match(r.stderr, /ROLLBACK INCOMPLETE/); assert.match(r.stderr, /move outcome unclear/);
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
    for (const service of ['chirpstack', 'redis']) assert.equal(fs.existsSync(g.p(service + '.running')), false);
    const lock = g.p('srv/backup/.chirpstack-maintenance.lock'); assert.ok(fs.existsSync(lock));
    assert.ok(fs.readdirSync(g.p('srv/backup')).some(n => n.startsWith('.chirpstack-stage.')));
    const token = fs.readFileSync(path.join(lock, 'recovery'), 'utf8');
    const commands = /BEGIN RECOVERY COMMANDS\n([^]*?)END RECOVERY COMMANDS/.exec(r.stderr); assert.ok(commands);
    const recovery = g.commands(commands[1]);
    if (outcome === 'both') { ok(recovery); assert.deepEqual(g.state(), before); g.running(); }
    else {
      assert.ifError(recovery.error); assert.notEqual(recovery.status, 0);
      assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
      assert.equal(fs.readFileSync(path.join(lock, 'recovery'), 'utf8'), token);
    }
  });
  test(`${label}: automatic rollback accepts a completed recovery rename reported failed`, t => {
    const g = gateway(t); g.backup(); const before = g.state();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', RECOVERY_MOVE_OUTCOME: 'renamed' }); bad(r);
    assert.match(r.stdout, /ROLLED BACK:/); assert.deepEqual(g.state(), before); g.running();
    assert.equal(fs.existsSync(g.p('unsafe-start')), false);
  });
  for (const outcome of ['renamed', 'both']) test(`${label}: printed recovery checks a failed rename outcome ${outcome}`, t => {
    const g = gateway(t); g.backup(); const before = g.state();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_COPY_AFTER: '1', FAIL_ROLLBACK_MOVE: 'chirpstack.sqlite' }); bad(r);
    const commands = /BEGIN RECOVERY COMMANDS\n([^]*?)END RECOVERY COMMANDS/.exec(r.stderr)[1];
    const lock = g.p('srv/backup/.chirpstack-maintenance.lock'); const token = fs.readFileSync(path.join(lock, 'recovery'), 'utf8');
    const first = g.commands(commands, { RECOVERY_MOVE_OUTCOME: outcome }); assert.ifError(first.error);
    if (outcome === 'both') {
      assert.notEqual(first.status, 0); assert.match(first.stderr, /move outcome unclear/);
      assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
      assert.equal(fs.readFileSync(path.join(lock, 'recovery'), 'utf8'), token);
      ok(g.commands(commands));
    } else ok(first);
    assert.deepEqual(g.state(), before); g.running(); assert.equal(fs.existsSync(g.p('unsafe-start')), false);
  });
  test(`${label}: recovery with another owner's token refuses without service or file changes`, t => {
    const g = gateway(t); g.backup();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_COPY_AFTER: '1', FAIL_ROLLBACK_MOVE: 'chirpstack.sqlite' }); bad(r);
    const commands = /BEGIN RECOVERY COMMANDS\n([^]*?)END RECOVERY COMMANDS/.exec(r.stderr)[1];
    const marker = g.p('srv/backup/.chirpstack-maintenance.lock/recovery'); fs.writeFileSync(marker, 'another-owner\n');
    const before = g.state(), calls = fs.readFileSync(g.p('calls'), 'utf8');
    const refused = g.commands(commands); assert.ifError(refused.error); assert.notEqual(refused.status, 0);
    assert.deepEqual(g.state(), before); assert.equal(fs.readFileSync(g.p('calls'), 'utf8'), calls);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'another-owner\n');
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
  test(`${label}: recovery retries unfinished work but rejects completed replay over new data`, t => {
    const g = gateway(t); g.backup(); const before = g.state();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    const commands = /BEGIN RECOVERY COMMANDS\n([^]*?)END RECOVERY COMMANDS/.exec(r.stdout + r.stderr)[1];
    const marker = g.p('srv/backup/.chirpstack-maintenance.lock/recovery');
    const token = fs.readFileSync(marker, 'utf8');
    const first = g.commands(commands, { FAIL_OPERATOR_FILE: 'chirpstack.sqlite-wal' }); assert.notEqual(first.status, 0);
    assert.equal(fs.readFileSync(marker, 'utf8'), token);
    for (const n of names) assert.ok(fs.readdirSync(path.dirname(g.live(n))).some(f => f.startsWith(path.basename(g.live(n)) + '.pre-restore-')));
    ok(g.commands(commands)); assert.deepEqual(g.state(), before);
    for (const n of names) fs.appendFileSync(g.live(n), 'new-data-' + n);
    const written = g.state(), calls = fs.readFileSync(g.p('calls'), 'utf8');
    const replay = g.commands(commands); assert.ifError(replay.error); assert.notEqual(replay.status, 0);
    assert.deepEqual(g.state(), written); assert.equal(fs.readFileSync(g.p('calls'), 'utf8'), calls);
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false); g.running();
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
  for (const action of ['TERM', 'HUP', 'INT', 'renamed-but-error', 'fail']) {
    test(`${label}: publication boundary ${action} preserves the set/archive invariant`, t => {
      const g = gateway(t); const oldSet = g.backup(); g.backup(true);
      const oldManifest = fs.readFileSync(path.join(oldSet, 'MANIFEST.sha256'));
      for (const n of ['chirpstack.sqlite', 'chirpstack.sqlite-wal', 'chirpstack.sqlite-shm']) {
        fs.rmSync(g.live(n), { force: true }); fs.rmSync(g.p('srv/backup/' + n), { force: true });
      }
      for (const [file, rows] of [[g.live('chirpstack.sqlite'), '(1),(2)'], [g.p('srv/backup/chirpstack.sqlite'), '(1)']]) {
        const db = new DatabaseSync(file); db.exec(`CREATE TABLE uplinks (id INTEGER); INSERT INTO uplinks VALUES ${rows}`); db.close();
      }
      for (const n of ['chirpstack.sqlite-wal', 'chirpstack.sqlite-shm']) fs.writeFileSync(g.p('srv/backup/' + n), 'stale-' + n);
      const before = Object.fromEntries(['chirpstack.sqlite', 'chirpstack.redis'].map(n => [n, fs.readFileSync(g.live(n))]));
      const r = g.run('backup', { PUBLISH_ACTION: action }); assert.ifError(r.error); g.running();
      if (action === 'fail') {
        bad(r);
        assert.deepEqual(fs.readFileSync(path.join(oldSet, 'MANIFEST.sha256')), oldManifest);
        for (const n of names) assert.ok(fs.existsSync(g.p('srv/backup/' + n)), 'failed rename returns flat files');
        assert.equal(fs.readdirSync(g.p('srv/backup')).some(n => n.startsWith('chirpstack-legacy-')), false);
        return;
      }
      const returnedFlats = names.filter(n => fs.existsSync(g.p('srv/backup/' + n)));
      const stock = fs.readFileSync(path.join(__dirname, 'fixtures/chirpstack-backup-restore/released-restore.sh'), 'utf8').replaceAll('/srv/', g.p('srv/'));
      const downgrade = g.commands(stock); assert.ifError(downgrade.error);
      const live = new DatabaseSync(g.live('chirpstack.sqlite'));
      const liveRows = live.prepare('SELECT count(*) AS n FROM uplinks').get().n; live.close();
      const set = new DatabaseSync(path.join(oldSet, 'chirpstack.sqlite'));
      const setRows = set.prepare('SELECT count(*) AS n FROM uplinks').get().n; set.close();
      t.diagnostic(JSON.stringify({ action, backupExit: r.status, returnedFlats, liveRows, setRows }));
      assert.deepEqual(returnedFlats, [], 'a completed publish never returns stale flat files');
      assert.equal(liveRows, 2); assert.equal(setRows, 2);
      for (const n of Object.keys(before)) assert.deepEqual(fs.readFileSync(g.live(n)), before[n], 'released downgrade leaves live bytes unchanged');
      if (action === 'renamed-but-error') bad(r);
      else ok(r); // Signals sent during the rename/bookkeeping fence are ignored.
    });
  }
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

  const recoveryBlock = r => {
    const match = /BEGIN RECOVERY COMMANDS\n([^]*?)END RECOVERY COMMANDS/.exec(r.stderr);
    assert.ok(match, r.stderr); return match[1];
  };
  const waitFor = async (file, child) => {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(file)) {
      assert.equal(child.exitCode, null, 'child still running before pause');
      assert.ok(Date.now() < deadline, 'reached pause before deadline');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  for (const op of ['backup', 'restore']) test(`${label}: recovery regression ${op} lock acquisition TERM cannot strand lock`, t => {
    const g = gateway(t); if (op === 'restore') g.backup();
    const r = g.run(op, { SIGNAL_LOCK: '1', FAIL_STAGE: '1' }); bad(r);
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
    assert.equal(fs.existsSync(g.p('calls')), false);
  });
  for (const op of ['backup', 'restore']) test(`${label}: recovery regression ${op} early failure preserves stopped services`, t => {
    const g = gateway(t);
    for (const name of ['redis', 'chirpstack']) fs.unlinkSync(g.p(name + '.running'));
    bad(g.run(op, op === 'backup' ? { FAIL_STAGE: '1' } : {}));
    assert.equal(fs.existsSync(g.p('calls')), false);
    for (const name of ['redis', 'chirpstack']) assert.equal(fs.existsSync(g.p(name + '.running')), false);
  });
  for (const helper of ['backup', 'restore']) test(`${label}: recovery regression ${helper} concurrent execution has one owner`, async t => {
    const g = gateway(t); g.backup(); const before = g.state();
    const r = helper === 'backup' ? g.run('backup', { START_FAIL: 'chirpstack' })
      : g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    const commands = recoveryBlock(r);
    const child = spawn(shell, [...args, '-c', commands], { env: g.environment(helper === 'backup' ? { PAUSE_START: 'chirpstack' } : { PAUSE_COPY: '.pending' }), stdio: 'ignore' });
    const finished = new Promise(resolve => child.on('close', status => resolve(status)));
    try {
      await waitFor(g.p('copy-paused'), child);
      const calls = fs.readFileSync(g.p('calls'), 'utf8');
      const contender = g.commands(commands); assert.ifError(contender.error); assert.notEqual(contender.status, 0);
      assert.equal(fs.readFileSync(g.p('calls'), 'utf8'), calls, 'loser has no cleanup or service calls');
      assert.ok(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock/recovery')));
    } finally {
      fs.writeFileSync(g.p('copy-resume'), 'yes');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await finished; } finally { clearTimeout(timer); }
    }
    assert.equal(child.exitCode, 0); assert.deepEqual(g.state(), before); g.running();
  });
  for (const absent of ['all', 'redis']) test(`${label}: recovery regression rollback to absent ${absent} permits restore retry`, t => {
    const g = gateway(t); g.backup();
    for (const n of absent === 'all' ? names : ['chirpstack.redis']) fs.unlinkSync(g.live(n));
    const before = Object.fromEntries(names.map(n => [n, fs.existsSync(g.live(n)) ? fs.readFileSync(g.live(n)) : null]));
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb' }); bad(r);
    assert.match(r.stdout, /ROLLED BACK:/);
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
    for (const n of names) assert.deepEqual(fs.existsSync(g.live(n)) ? fs.readFileSync(g.live(n)) : null, before[n]);
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
    ok(g.run('restore')); g.running();
  });
  for (const helper of ['restore']) test(`${label}: recovery regression ${helper} printed absent inventory can unlock for retry`, t => {
    const g = gateway(t); g.backup(); fs.unlinkSync(g.live('chirpstack.redis'));
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'chirpstack.sqlite' }); bad(r);
    ok(g.commands(recoveryBlock(r)));
    assert.equal(fs.existsSync(g.live('chirpstack.redis')), false);
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
    ok(g.run('restore')); g.running();
  });
  test(`${label}: recovery regression token write fails before any service or live change`, t => {
    const g = gateway(t); g.backup(); const before = g.state();
    // Make only the ownership-token path unwritable, even as root.
    fs.unlinkSync(g.p('bin/mkdir'));
    fs.writeFileSync(g.p('bin/mkdir'), `#!/bin/sh\n'${find('mkdir')}' "$@" || exit 1\nif [ "$1" = "$OSI_CS_ROOT/srv/backup/.chirpstack-maintenance.lock" ]; then '${find('mkdir')}' "$1/recovery"; fi\n`, { mode: 0o755 });
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    assert.equal(fs.existsSync(g.p('calls')), false); assert.deepEqual(g.state(), before);
  });
  test(`${label}: recovery regression token survives later filesystem write failure`, t => {
    const g = gateway(t); g.backup();
    const service = fs.readFileSync(g.p('bin/service'), 'utf8');
    fs.writeFileSync(g.p('bin/service'), service.replace('echo "$*" >> "$OSI_CS_ROOT/calls"', `if [ "$2" = stop ] && [ ! -f "$OSI_CS_ROOT/token-seen" ]; then
  test -s "$OSI_CS_ROOT/srv/backup/.chirpstack-maintenance.lock/recovery" || exit 3
  echo yes > "$OSI_CS_ROOT/token-seen"
  chmod 400 "$OSI_CS_ROOT/srv/backup/.chirpstack-maintenance.lock/recovery"
fi
echo "$*" >> "$OSI_CS_ROOT/calls"`));
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    assert.ok(fs.existsSync(g.p('token-seen')));
    ok(g.commands(recoveryBlock(r))); g.running();
  });
  test(`${label}: recovery regression failed automatic rollback restart keeps checked retry`, t => {
    const g = gateway(t); g.backup(); const before = g.state();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', START_FAIL: 'chirpstack' }); bad(r);
    assert.ok(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock/recovery')));
    assert.ok(fs.readdirSync(g.p('srv/backup')).some(n => n.startsWith('.chirpstack-stage.')));
    ok(g.commands(recoveryBlock(r))); assert.deepEqual(g.state(), before); g.running();
  });
  for (const action of ['TERM', 'error']) test(`${label}: recovery regression archive rename ${action} returns committed flat file`, t => {
    const g = gateway(t); g.backup(true); const before = fs.readFileSync(g.p('srv/backup/chirpstack.sqlite'));
    bad(g.run('backup', { ARCHIVE_ACTION: action }));
    assert.deepEqual(fs.readFileSync(g.p('srv/backup/chirpstack.sqlite')), before);
    assert.equal(fs.existsSync(g.p('srv/backup/chirpstack-set')), false); g.running();
  });
  function unstableProbe(g) {
    fs.writeFileSync(g.p('bin/pidof'), `#!/bin/sh
case "$1" in redis-server) s=redis;; *) s=$1;; esac
[ -f "$OSI_CS_ROOT/$s.running" ] || exit 1
if [ "$s" = chirpstack ] && [ ! -f "$OSI_CS_ROOT/chirpstack-probed" ]; then
  echo yes > "$OSI_CS_ROOT/chirpstack-probed"
  rm -f "$OSI_CS_ROOT/redis.running"
  exit 1
fi
echo 123
`);
  }
  test(`${label}: recovery regression restart observes both services in one poll`, t => {
    const g = gateway(t); unstableProbe(g);
    bad(g.run('backup'));
  });
  test(`${label}: recovery regression printed restart keeps lock if Redis exits while waiting`, t => {
    const g = gateway(t); g.backup();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    unstableProbe(g);
    const recovery = g.commands(recoveryBlock(r)); assert.ifError(recovery.error); assert.notEqual(recovery.status, 0);
    assert.ok(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock/recovery')));
  });
  test(`${label}: recovery regression printed stop polls delayed exit`, t => {
    const g = gateway(t); g.backup();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    const service = fs.readFileSync(g.p('bin/service'), 'utf8');
    fs.writeFileSync(g.p('bin/service'), service.replace('rm -f "$OSI_CS_ROOT/$1.running"', 'echo yes > "$OSI_CS_ROOT/$1.running"; echo yes > "$OSI_CS_ROOT/$1.stopping"'));
    const probe = fs.readFileSync(g.p('bin/pidof'), 'utf8');
    fs.writeFileSync(g.p('bin/pidof'), probe.replace('echo 123', 'if [ -f "$OSI_CS_ROOT/$s.stopping" ]; then rm -f "$OSI_CS_ROOT/$s.running" "$OSI_CS_ROOT/$s.stopping"; fi\necho 123'));
    ok(g.commands(recoveryBlock(r))); g.running();
  });
  test(`${label}: recovery regression prune failure warns after completed restore`, t => {
    const g = gateway(t); g.backup();
    const retained = g.live('chirpstack.sqlite') + '.pre-restore-20200101T000000Z-123';
    fs.symlinkSync(g.live('chirpstack.sqlite'), retained);
    const r = g.run('restore'); ok(r); assert.match(r.stdout, /OK: restored/); assert.match(r.stderr, /WARNING: retention/);
    assert.ok(fs.lstatSync(retained).isSymbolicLink()); g.running();
  });
  test(`${label}: recovery regression early contender exit is bounded`, t => {
    const g = gateway(t); fs.mkdirSync(g.p('srv/backup/.chirpstack-maintenance.lock'));
    const started = Date.now();
    const result = g.commands('rmdir "$OSI_CS_ROOT/srv/backup/.chirpstack-maintenance.lock"', { RACE_UNLOCK: '1' });
    assert.ifError(result.error); assert.notEqual(result.status, 0);
    assert.ok(Date.now() - started < 5000); assert.match(result.stderr, /contender.*(exit|deadline)/i);
  });
  test(`${label}: asynchronous recovery command deadline terminates children`, async t => {
    const g = gateway(t);
    const result = await g.commandAsync(`'${find('sleep')}' 30`, { RACE_UNLOCK: '0' }, 100);
    assert.match(result.error.message, /deadline/);
    assert.equal(result.status, null);
  });

  for (const op of ['backup', 'restore']) test(`${label}: recovery limits early stop failure to the attempted service for ${op}`, t => {
    const g = gateway(t); if (op === 'restore') g.backup();
    fs.unlinkSync(g.p('redis.running'));
    const service = fs.readFileSync(g.p('bin/service'), 'utf8');
    fs.writeFileSync(g.p('bin/service'), service.replace('[ "${STOP_ERROR:-}" != "$1" ] || exit 1', '[ "${STOP_ERROR:-}" != "$1" ] || { rm -f "$OSI_CS_ROOT/$1.running"; exit 1; }'));
    bad(g.run(op, { STOP_ERROR: 'chirpstack' }));
    assert.equal(fs.existsSync(g.p('chirpstack.running')), true, 'partially successful stop is recovered');
    assert.equal(fs.existsSync(g.p('redis.running')), false, 'unattempted service stays stopped');
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /redis start/);
  });
  test(`${label}: failure during move with absent Redis restores inventory without starting`, t => {
    const g = gateway(t); g.backup(); fs.unlinkSync(g.live('chirpstack.redis'));
    const main = fs.readFileSync(g.live('chirpstack.sqlite'));
    const r = g.run('restore', { FAIL_MOVE: 'chirpstack.sqlite-wal' }); bad(r);
    assert.match(r.stdout, /ROLLED BACK:/); assert.deepEqual(fs.readFileSync(g.live('chirpstack.sqlite')), main);
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
    ok(g.run('restore'));
  });
  test(`${label}: failure to record full original inventory never emits destructive recovery`, t => {
    const g = gateway(t); g.backup(); const before = g.state();
    // Replace the symlink before writing the fault shim.
    fs.unlinkSync(g.p('bin/sha256sum'));
    fs.writeFileSync(g.p('bin/sha256sum'), `#!/bin/sh
case "$*" in *srv/chirpstack/chirpstack.sqlite-wal) exit 1;; esac
exec '${find('sha256sum')}' "$@"
`, { mode: 0o755 });
    const r = g.run('restore', { START_FAIL: 'chirpstack' }); bad(r);
    assert.doesNotMatch(recoveryBlock(r), /remove originally absent/);
    fs.unlinkSync(g.p('bin/sha256sum')); fs.symlinkSync(find('sha256sum'), g.p('bin/sha256sum'));
    ok(g.commands(recoveryBlock(r))); assert.deepEqual(g.state(), before); g.running();
  });

  test(`${label}: recovery first move failure with absent Redis never starts incomplete originals`, t => {
    const g = gateway(t); g.backup(); fs.unlinkSync(g.live('chirpstack.redis'));
    const before = fs.readFileSync(g.live('chirpstack.sqlite'));
    bad(g.run('restore', { FAIL_MOVE: 'srv/chirpstack/chirpstack.sqlite' }));
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
    assert.deepEqual(fs.readFileSync(g.live('chirpstack.sqlite')), before);
    assert.equal(fs.existsSync(g.live('chirpstack.redis')), false);
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
    ok(g.run('restore')); g.running();
  });
  test(`${label}: recovery unfinished original hashes with absent Redis stays stopped and retryable`, t => {
    const g = gateway(t); g.backup(); fs.unlinkSync(g.live('chirpstack.redis'));
    fs.unlinkSync(g.p('bin/sha256sum'));
    fs.writeFileSync(g.p('bin/sha256sum'), `#!/bin/sh
case "$*" in *srv/chirpstack/chirpstack.sqlite-wal) exit 1;; esac
exec '${find('sha256sum')}' "$@"
`, { mode: 0o755 });
    const r = g.run('restore'); bad(r);
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
    assert.ok(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock/recovery')));
    const commands = recoveryBlock(r); assert.doesNotMatch(commands, /remove originally absent/);
    fs.unlinkSync(g.p('bin/sha256sum')); fs.symlinkSync(find('sha256sum'), g.p('bin/sha256sum'));
    const originalMain = fs.readFileSync(g.live('chirpstack.sqlite'));
    fs.appendFileSync(g.live('chirpstack.sqlite'), 'changed-known-original');
    const rejected = g.commands(commands); assert.notEqual(rejected.status, 0);
    assert.ok(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock/recovery')));
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
    fs.writeFileSync(g.live('chirpstack.sqlite'), originalMain);
    ok(g.commands(commands));
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /start/);
    assert.equal(fs.existsSync(g.live('chirpstack.redis')), false);
    ok(g.run('restore')); g.running();
  });
  for (const op of ['backup', 'restore']) test(`${label}: recovery printed early-stop retry preserves unattempted Redis for ${op}`, t => {
    const g = gateway(t); if (op === 'restore') g.backup(); fs.unlinkSync(g.p('redis.running'));
    const r = g.run(op, { STOP_ERROR: 'chirpstack', START_FAIL: 'chirpstack' }); bad(r);
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /redis/);
    const commands = recoveryBlock(r);
    const failed = g.commands(commands, { START_FAIL: 'chirpstack' }); assert.notEqual(failed.status, 0);
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /redis/);
    ok(g.commands(commands));
    assert.equal(fs.existsSync(g.p('redis.running')), false);
    assert.equal(fs.existsSync(g.p('chirpstack.running')), true);
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8'), /redis/);
  });
  function signalCreator(g, target) {
    fs.unlinkSync(g.p('bin/mkdir'));
    fs.writeFileSync(g.p('bin/mkdir'), `#!/bin/sh
'${find('mkdir')}' "$@" || exit $?
case "$1" in ${target}) kill -TERM "$PPID"; kill -TERM "$$";; esac
`, { mode: 0o755 });
  }
  for (const op of ['backup', 'restore']) test(`${label}: recovery group TERM at maintenance mkdir is fenced for ${op}`, t => {
    const g = gateway(t); if (op === 'restore') g.backup();
    signalCreator(g, '"$OSI_CS_ROOT/srv/backup/.chirpstack-maintenance.lock"');
    ok(g.run(op));
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
    ok(g.run(op)); g.running();
  });
  for (const helper of ['backup', 'restore']) test(`${label}: recovery group TERM at claim mkdir is fenced for ${helper}`, t => {
    const g = gateway(t); g.backup();
    const r = helper === 'backup' ? g.run('backup', { START_FAIL: 'chirpstack' })
      : g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    const commands = recoveryBlock(r);
    signalCreator(g, '"$OSI_CS_ROOT/srv/backup/.chirpstack-maintenance.lock.recovery-"*');
    ok(g.commands(commands)); g.running();
    assert.deepEqual(fs.readdirSync(g.p('srv/backup')).filter(n => n.includes('.lock.recovery-')), []);
  });
  for (const helper of ['backup', 'restore']) test(`${label}: recovery retries an abandoned empty execution claim for ${helper}`, t => {
    const g = gateway(t); g.backup();
    const r = helper === 'backup' ? g.run('backup', { START_FAIL: 'chirpstack' })
      : g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    const commands = recoveryBlock(r);
    const lock = g.p('srv/backup/.chirpstack-maintenance.lock');
    const token = fs.readFileSync(path.join(lock, 'recovery'), 'utf8').trim();
    fs.mkdirSync(lock + '.recovery-' + token);
    ok(g.commands(commands)); g.running();
    assert.equal(fs.existsSync(lock + '.recovery-' + token), false);
  });
  test(`${label}: recovery retries after SIGKILL releases the live execution owner`, async t => {
    const g = gateway(t); g.backup();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    const commands = recoveryBlock(r);
    const child = spawn(shell, [...args, '-c', commands], { env: g.environment({ PAUSE_COPY: '.pending' }), stdio: 'ignore', detached: true });
    const ended = new Promise(resolve => child.on('close', status => resolve(status)));
    try { await waitFor(g.p('copy-paused'), child); }
    finally { process.kill(-child.pid, 'SIGKILL'); await ended; }
    ok(g.commands(commands)); g.running();
  });

  test(`${label}: recovery never clears a nonempty abandoned execution claim`, t => {
    const g = gateway(t); g.backup();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    const lock = g.p('srv/backup/.chirpstack-maintenance.lock');
    const claim = lock + '.recovery-' + fs.readFileSync(path.join(lock, 'recovery'), 'utf8').trim();
    fs.mkdirSync(claim); fs.writeFileSync(path.join(claim, 'retained-original'), 'retain');
    const calls = fs.readFileSync(g.p('calls'), 'utf8');
    const retry = g.commands(recoveryBlock(r)); assert.notEqual(retry.status, 0);
    assert.equal(fs.readFileSync(g.p('calls'), 'utf8'), calls);
    assert.equal(fs.readFileSync(path.join(claim, 'retained-original'), 'utf8'), 'retain');
    assert.ok(fs.existsSync(path.join(lock, 'recovery')));
  });
  test(`${label}: delayed recovery cannot change a newer maintenance generation`, async t => {
    const g = gateway(t); g.backup(); const before = g.state();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    const commands = recoveryBlock(r);
    // Pause immediately before the new exclusive-owner boundary. The earlier
    // probe paused before mkdir, which now runs only after flock is held.
    fs.unlinkSync(g.p('bin/flock'));
    fs.writeFileSync(g.p('bin/flock'), `#!/bin/sh
if [ "\${WAIT_CLAIM:-0}" = 1 ]; then
  echo yes > "$OSI_CS_ROOT/claim-paused"
  n=0
  while [ ! -f "$OSI_CS_ROOT/claim-resume" ]; do
    n=$((n+1)); [ "$n" -lt 500 ] || exit 3
    '${find('sleep')}' 0.01
  done
fi
exec ${flockCommand} "$@"
`, { mode: 0o755 });
    const child = spawn(shell, [...args, '-c', commands], { env: g.environment({ WAIT_CLAIM: '1' }), stdio: 'ignore' });
    const ended = new Promise(resolve => child.on('close', status => resolve(status)));
    try {
      await waitFor(g.p('claim-paused'), child);
      ok(g.commands(commands)); assert.deepEqual(g.state(), before); g.running();
      const lock = g.p('srv/backup/.chirpstack-maintenance.lock'); fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'recovery'), 'new-maintenance-owner\n');
      const calls = fs.readFileSync(g.p('calls'), 'utf8');
      fs.writeFileSync(g.p('claim-resume'), 'yes');
      assert.equal(await ended, 1);
      assert.equal(fs.readFileSync(g.p('calls'), 'utf8'), calls);
      assert.equal(fs.readFileSync(path.join(lock, 'recovery'), 'utf8'), 'new-maintenance-owner\n');
      assert.deepEqual(g.state(), before); g.running();
    } finally {
      fs.writeFileSync(g.p('claim-resume'), 'yes'); if (child.exitCode === null) child.kill('SIGKILL'); await ended;
    }
  });

  for (const op of ['backup', 'restore']) test(`${label}: ${op} recovery survives late mktemp failure`, t => {
    const g = gateway(t); if (op === 'restore') g.backup(); const before = g.state();
    fs.writeFileSync(g.p('bin/mktemp'), `#!/bin/sh
if [ -f "$OSI_CS_ROOT/start-failed" ]; then exit 1; fi
case "$*" in *chirpstack-stage*) [ ! -d "$OSI_CS_ROOT/srv/backup/chirpstack-set" ] || [ "${op}" != backup ] || exit 1;; esac
exec '${find('mktemp')}' "$@"
`, { mode: 0o755 });
    // A persistent restart fault ensures recovery, even if a start spawned a writer.
    const service = fs.readFileSync(g.p('bin/service'), 'utf8');
    fs.writeFileSync(g.p('bin/service'), service.replace('start) ', 'start) echo yes > "$OSI_CS_ROOT/start-failed"; '));
    const r = g.run(op, { START_FAIL: 'chirpstack' }); bad(r);
    const commands = recoveryBlock(r); assert.doesNotMatch(commands, /recovery_manifest=''/);
    assert.ok(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock/recovery')));
    fs.writeFileSync(g.p('bin/mktemp'), `#!/bin/sh\nexec '${find('mktemp')}' "$@"\n`, { mode: 0o755 });
    ok(g.commands(commands)); assert.deepEqual(g.state(), before); g.running();
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
  });
  for (const op of ['restore']) test(`${label}: ${op} recovery-state preflight failure makes no service call`, t => {
    const g = gateway(t); if (op === 'restore') g.backup(); const before = g.state();
    for (const n of ['redis', 'chirpstack']) fs.unlinkSync(g.p(n + '.running'));
    fs.writeFileSync(g.p('bin/mktemp'), `#!/bin/sh
case "$*" in *chirpstack-recovery.*) exit 1;; esac
exec '${find('mktemp')}' "$@"
`, { mode: 0o755 });
    const r = g.run(op); bad(r);
    assert.equal(fs.existsSync(g.p('calls')), false); assert.deepEqual(g.state(), before);
    assert.doesNotMatch(r.stderr, /BEGIN RECOVERY COMMANDS/);
    assert.match(r.stderr, /repair.*storage.*rerun/i);
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
    for (const n of ['redis', 'chirpstack']) assert.equal(fs.existsSync(g.p(n + '.running')), false);
  });

  for (const op of ['backup', 'restore']) test(`${label}: ${op} refuses missing flock before any maintenance change`, t => {
    const g = gateway(t); if (op === 'restore') g.backup(); const before = g.state();
    fs.unlinkSync(g.p('bin/flock'));
    const r = g.run(op); bad(r); assert.match(r.stderr, /flock is required for recovery/);
    assert.equal(fs.existsSync(g.p('calls')), false); assert.deepEqual(g.state(), before);
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
  });
  test(`${label}: printed recovery refuses missing flock without disturbing generation`, t => {
    const g = gateway(t); g.backup();
    const r = g.run('restore', { FAIL_COPY: 'srv/redis/dump.rdb', FAIL_COPY_AFTER: '1', FAIL_ROLLBACK_MOVE: 'dump.rdb' }); bad(r);
    fs.unlinkSync(g.p('bin/flock'));
    const before = g.state(), calls = fs.readFileSync(g.p('calls'), 'utf8');
    const retry = g.commands(recoveryBlock(r)); assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /requires BusyBox flock; lock retained/);
    assert.deepEqual(g.state(), before); assert.equal(fs.readFileSync(g.p('calls'), 'utf8'), calls);
    assert.ok(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock/recovery')));
  });
  for (const op of ['restore']) test(`${label}: ${op} unwritable original manifest aborts with checked storage procedure`, t => {
    const g = gateway(t); if (op === 'restore') g.backup(); const before = g.state();
    fs.unlinkSync(g.p('bin/chmod'));
    fs.writeFileSync(g.p('bin/chmod'), `#!/bin/sh
'${find('chmod')}' "$@" || exit 1
case "$2" in *chirpstack-recovery.*) '${find('mkdir')}' "$2/ORIGINAL.sha256";; esac
`, { mode: 0o755 });
    const r = g.run(op); bad(r); assert.match(r.stderr, /repair backup storage and rerun this helper/);
    assert.doesNotMatch(r.stderr, /BEGIN RECOVERY COMMANDS/);
    assert.equal(fs.existsSync(g.p('calls')), false); assert.deepEqual(g.state(), before);
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
  });

  test(`${label}: backup restart recovery accepts a legitimate checkpoint after failed start`, t => {
    const g = gateway(t);
    const service = fs.readFileSync(g.p('bin/service'), 'utf8');
    const checkpoint = g.p('checkpointed.sqlite');
    fs.copyFileSync(g.live('chirpstack.sqlite'), checkpoint);
    for (const suffix of ['-wal', '-shm']) fs.copyFileSync(g.live('chirpstack.sqlite' + suffix), checkpoint + suffix);
    const db = new DatabaseSync(checkpoint);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('SELECT * FROM uplinks').all().length, 1); db.close();
    fs.writeFileSync(g.p('bin/service'), service.replace('start) ', `start) if [ "$1" = chirpstack ]; then
      cp "$OSI_CS_ROOT/checkpointed.sqlite" "$OSI_CS_ROOT/srv/chirpstack/chirpstack.sqlite"
      rm -f "$OSI_CS_ROOT/srv/chirpstack/chirpstack.sqlite-wal" "$OSI_CS_ROOT/srv/chirpstack/chirpstack.sqlite-shm"
      echo yes > "$OSI_CS_ROOT/chirpstack.running"
    fi
    `));
    const r = g.run('backup', { START_FAIL: 'chirpstack' }); bad(r);
    const commands = recoveryBlock(r);
    assert.doesNotMatch(commands, /sha256sum|recovery_manifest|service (?:redis|chirpstack) stop/);
    fs.writeFileSync(g.p('bin/service'), service);
    const calls = fs.readFileSync(g.p('calls'), 'utf8');
    const failedRetry = g.commands(commands, { START_FAIL: 'chirpstack' }); assert.notEqual(failedRetry.status, 0);
    assert.ok(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock/recovery')));
    assert.doesNotMatch(fs.readFileSync(g.p('calls'), 'utf8').slice(calls.length), /stop/);
    ok(g.commands(commands)); g.running();
    assert.equal(fs.existsSync(g.p('srv/backup/.chirpstack-maintenance.lock')), false);
    const live = new DatabaseSync(g.live('chirpstack.sqlite'));
    assert.equal(live.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(live.prepare('SELECT * FROM uplinks').all().length, 1); live.close();
    const replay = g.commands(commands); assert.notEqual(replay.status, 0);
    ok(g.run('backup')); ok(g.run('restore'));
  });

}
