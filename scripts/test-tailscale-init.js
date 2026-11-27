'use strict';
// The OSI copy of the tailscale init time-limits the cleanup that the package
// file runs without a limit before the daemon, keeps that cleanup off procd's
// service lock, and starts the service at 99, after ChirpStack, Node-RED and
// osi-bootstrap. The static tests pin it to the package file: everything but
// those changes must stay as the package ships it. The behavioural tests run
// its cleanup helper with a stand-in for tailscaled on the host shell; the
// emulator boot tests (tools/raspi5/acceptance.py, "Tailscale" cases) run it
// under the image's own ash and procd.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709'];
const INIT = 'files/etc/init.d/tailscale';
const PACKAGE_INIT = path.join(ROOT, 'scripts/fixtures/tailscale-package-init/1.80.3-r1.init');
const HELPER = 'osi_tailscale_cleanup() {';

const initPath = (profile) => path.join(ROOT, 'conf', profile, INIT);
const read = (file) => fs.readFileSync(file, 'utf8');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function helperSource(source) {
  const start = source.indexOf(HELPER);
  assert.ok(start >= 0, 'the init defines its cleanup helper');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'the cleanup helper is closed');
  return source.slice(start, end + 3);
}

function codeLines(text) {
  return text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

test('both profiles ship the same executable tailscale init', () => {
  assert.deepEqual(fs.readFileSync(initPath(PROFILES[0])), fs.readFileSync(initPath(PROFILES[1])));
  for (const profile of PROFILES) {
    assert.equal(fs.statSync(initPath(profile)).mode & 0o777, 0o755, `${profile}: the init is executable`);
  }
  const syntax = spawnSync('sh', ['-n', initPath(PROFILES[0])], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('the fixture is the tailscale 1.80.3-r1 package init', () => {
  assert.equal(sha256(PACKAGE_INIT), 'a874f9fd10321e57b00660af11695618e23fb622bb1a40bcd0d366dad1340e56');
  assert.match(read(PACKAGE_INIT), /^START=80$/m);
  assert.equal(read(PACKAGE_INIT).split('/usr/sbin/tailscaled --cleanup\n').length - 1, 2);
});

test('the init changes the package file only where intended', () => {
  const source = read(initPath(PROFILES[0]));
  const ours = codeLines(source);
  const helper = codeLines(helperSource(source));
  const helperAt = ours.indexOf(HELPER);
  assert.ok(helperAt > 0);
  const withoutHelper = [...ours.slice(0, helperAt), ...ours.slice(helperAt + helper.length)];
  const expected = codeLines(read(PACKAGE_INIT)).map((line) => {
    if (line === 'START=80') return 'START=99';
    return line === '/usr/sbin/tailscaled --cleanup' ? 'osi_tailscale_cleanup' : line;
  });
  const added = ['OSI_CLEANUP_LIMIT=15'];
  assert.deepEqual(withoutHelper.filter((line) => !added.includes(line)), expected);
  assert.deepEqual(added.filter((line) => !withoutHelper.includes(line)), []);
  assert.deepEqual(helper.slice(0, 2), [HELPER, 'osi_dir="$(mktemp -d /tmp/tailscale-cleanup.XXXXXX)" || return 0']);
});

test('the service starts after ChirpStack, Node-RED and osi-bootstrap', () => {
  // rc.d runs its S links in lexical order (procd rcS globs /etc/rc.d/S*).
  // All of these start at 99 on the 0.8.0 and 0.8.4 images.
  const source = read(initPath(PROFILES[0]));
  assert.match(source, /^START=99$/m);
  for (const [file, start] of [
    ['feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init', 'START=99'],
    ['conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap', 'START=99'],
  ]) {
    assert.match(read(path.join(ROOT, file)), new RegExp(`^${start}$`, 'm'), `${file} keeps ${start}`);
  }
  assert.doesNotMatch(source, /^STOP=/m);
  const link = 'S99tailscale';
  for (const before of ['S99chirpstack', 'S99chirpstack-concentratord', 'S99node-red', 'S99osi-bootstrap', 'S98osi-identityd']) {
    assert.ok(before < link, `${link} must sort after ${before}`);
  }
  for (const after of ['S99urandom_seed', 'S99zzz-lorawan-devices.init']) {
    assert.ok(after > link, `${link} must sort before ${after}: that script waits for it`);
  }
});

test('the init needs no command absent on the gateway bases', () => {
  const { ABSENT_ON_BOTH } = require('./helpers/gateway-base-commands');
  const source = read(initPath(PROFILES[0]));
  const absent = new RegExp(`(^|[\\s;|&(\`!])(${ABSENT_ON_BOTH.join('|')})\\s`);
  for (const { line, at } of codeLinesWithPositions(source)) {
    assert.ok(!absent.test(line), `${at}: ${line.trim()}`);
  }
  assert.doesNotMatch(codeLines(source).join('\n'), /\btr\b[^|;]*\[:[a-z]+:\]/);
});

function codeLinesWithPositions(text) {
  return text.split('\n')
    .map((line, i) => ({ line: line.replace(/(^|\s)#.*$/, ''), at: `${INIT}:${i + 1}` }))
    .filter(({ line }) => line.trim() && !/^\s*(echo|printf)\b/.test(line));
}

// The helper as shipped, with its two absolute paths pointed at the fixture.
function fixtureHelper(source, standin, dir) {
  let text = helperSource(source);
  for (const [from, to] of [
    ['/usr/sbin/tailscaled --cleanup &', `${standin} --cleanup &`],
    ['mktemp -d /tmp/tailscale-cleanup.XXXXXX', `mktemp -d ${dir}/tailscale-cleanup.XXXXXX`],
  ]) {
    assert.equal(text.split(from).length - 1, 1, `the helper contains ${from} once`);
    text = text.replace(from, to);
  }
  return text;
}

function makeFixture(name, { hang, standinName = 'tailscaled', standinStatus = '0' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `osi-tailscale-init-${name}-`));
  const standin = path.join(dir, standinName);
  fs.writeFileSync(standin, [
    '#!/usr/bin/env node',
    "require('node:fs').writeFileSync(process.env.STANDIN_PIDFILE, String(process.pid));",
    hang ? 'setInterval(() => {}, 1000);' : 'process.exitCode = Number(process.env.STANDIN_STATUS || 0);',
    '',
  ].join('\n'), { mode: 0o755 });
  return {
    dir, standin, standinStatus,
    pidFile: path.join(dir, 'standin.pid'), log: path.join(dir, 'logger.log'), result: path.join(dir, 'result'),
  };
}

function runHelper(fixture, limit, preamble = '') {
  // The child's output goes to files, not to pipes: a stand-in that
  // outlives the helper keeps the shell's stdio, and a piped spawnSync
  // would wait for its exit instead of the shell's. procd's boot runner
  // likewise stops at the script's exit, not at the last writer.
  const script = `
exec >"$FIXTURE/stdout" 2>"$FIXTURE/stderr"
set +e
eval "$PREAMBLE"
logger() {
    [ "$1" = "-t" ] && { printf '%s: ' "$2"; shift 2; }
    printf '%s\\n' "$*"
} >>"$FIXTURE/logger.log"
eval "$CLEANUP_SOURCE"
OSI_CLEANUP_LIMIT=$LIMIT
osi_tailscale_cleanup
printf '%s' "$?" >"$FIXTURE/result"
`;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('STANDIN_'))),
    CLEANUP_SOURCE: fixtureHelper(read(initPath(PROFILES[0])), fixture.standin, fixture.dir),
    FIXTURE: fixture.dir,
    LIMIT: String(limit),
    PREAMBLE: preamble,
    STANDIN_PIDFILE: fixture.pidFile,
    STANDIN_STATUS: fixture.standinStatus,
    TMPDIR: fixture.dir,
  };
  const standinPid = () => (fs.existsSync(fixture.pidFile) ? Number(fs.readFileSync(fixture.pidFile, 'utf8')) : null);
  const started = performance.now();
  // bash, not sh: the helper closes fd 1000 as the image's BusyBox ash and
  // procd.sh address it, and dash (sh on Debian and Ubuntu) has single-digit
  // fds only; it would run `1000` as a command.
  const run = spawnSync('bash', ['-c', script], { stdio: 'ignore', env, timeout: 60_000 });
  const seconds = (performance.now() - started) / 1000;
  if (run.error || run.signal) {
    // A helper that did not return: end its stand-in before reporting.
    stop(standinPid());
  }
  assert.equal(run.error, undefined, run.error && run.error.message);
  assert.equal(run.signal, null, `the shell was killed by ${run.signal}`);
  const stderr = fs.existsSync(path.join(fixture.dir, 'stderr')) ? fs.readFileSync(path.join(fixture.dir, 'stderr'), 'utf8') : '';
  assert.equal(run.status, 0, stderr);
  return {
    seconds,
    status: Number(fs.readFileSync(fixture.result, 'utf8')),
    stderr,
    log: fs.existsSync(fixture.log) ? fs.readFileSync(fixture.log, 'utf8') : '',
    standinPid: standinPid(),
    cleanupDirs: fs.readdirSync(fixture.dir).filter((name) => name.startsWith('tailscale-cleanup.')),
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { assert.equal(error.code, 'ESRCH'); return false; }
}

// SIGKILL is delivered after the helper has returned: wait for the reaping.
async function gone(pid) {
  for (let i = 0; i < 100 && alive(pid); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !alive(pid);
}

function stop(pid) {
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already gone */ } }
}

const LIMIT = 2;

test('a cleanup that exits returns at once, logs nothing and leaves no directory', () => {
  const fixture = makeFixture('fast');
  try {
    const run = runHelper(fixture, LIMIT);
    assert.equal(run.status, 0);
    assert.ok(run.seconds < LIMIT, `returned after ${run.seconds.toFixed(2)} s`);
    assert.deepEqual(run.cleanupDirs, []);
    assert.equal(run.log, '');
    assert.equal(alive(run.standinPid), false);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test('the exit status of the cleanup is not the helper\'s', () => {
  for (const status of ['1', '143']) {
    const fixture = makeFixture(`status-${status}`, { standinStatus: status });
    try {
      const run = runHelper(fixture, LIMIT);
      assert.equal(run.status, 0);
      assert.ok(run.seconds < LIMIT);
      assert.equal(run.log, '');
    } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
  }
});

test('a cleanup that does not return is killed at the limit and the helper returns', async () => {
  const fixture = makeFixture('hang', { hang: true });
  let pid = null;
  try {
    const run = runHelper(fixture, LIMIT);
    pid = run.standinPid;
    assert.ok(pid > 0, 'the stand-in started');
    assert.equal(run.status, 0);
    assert.ok(run.seconds >= LIMIT, `returned after ${run.seconds.toFixed(2)} s`);
    assert.ok(run.seconds < LIMIT + 2, `returned after ${run.seconds.toFixed(2)} s`);
    assert.equal(await gone(pid), true, 'the hung cleanup was killed');
    assert.deepEqual(run.log.split('\n').filter(Boolean), ['tailscale: cleanup did not finish in 2 s; continuing without it']);
  } finally { stop(pid); fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test('a cleanup the kill cannot end does not keep the helper waiting', () => {
  // No host process survives SIGKILL, so `kill` is a no-op here. That is what
  // the helper sees when the cleanup is stuck in the kernel past the limit.
  // A helper that waits for the cleanup itself would never return.
  const fixture = makeFixture('stuck', { hang: true });
  let pid = null;
  try {
    const run = runHelper(fixture, LIMIT, 'kill() { return 0; }\n');
    pid = run.standinPid;
    assert.ok(pid > 0, 'the stand-in started');
    assert.equal(run.status, 0);
    assert.ok(run.seconds >= LIMIT, `returned after ${run.seconds.toFixed(2)} s`);
    assert.ok(run.seconds < LIMIT + 2, `returned after ${run.seconds.toFixed(2)} s`);
    assert.equal(alive(pid), true, 'nothing could end it');
    assert.match(run.log, /continuing without it/);
  } finally { stop(pid); fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test('a process the kill does not reach does not keep the helper waiting', () => {
  // The stand-in's name is not tailscaled, so the helper's check of the
  // recorded pid refuses the kill, as it must when a pid was reused.
  const fixture = makeFixture('unkillable', { hang: true, standinName: 'other-daemon' });
  let pid = null;
  try {
    const run = runHelper(fixture, LIMIT);
    pid = run.standinPid;
    assert.ok(run.seconds >= LIMIT, `returned after ${run.seconds.toFixed(2)} s`);
    assert.ok(run.seconds < LIMIT + 2, `returned after ${run.seconds.toFixed(2)} s`);
    assert.equal(alive(pid), true, 'the kill was refused');
    assert.deepEqual(run.log.split('\n').filter(Boolean), ['tailscale: cleanup did not finish in 2 s; continuing without it']);
  } finally { stop(pid); fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test('osi-bootstrap returns at once on a provisioned gateway, so remote access waits for it only briefly', () => {
  // S99osi-bootstrap runs right before S99tailscale. Its boot start must test
  // its stamp before anything that can wait (the ChirpStack poll, node).
  const source = read(path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap'));
  const body = (name) => {
    const start = source.indexOf(`\n${name}() {\n`);
    assert.ok(start >= 0, `osi-bootstrap defines ${name}()`);
    return codeLines(source.slice(start + name.length + 6, source.indexOf('\n}\n', start)));
  };
  assert.deepEqual(body('boot'), ['start']);
  assert.deepEqual(body('start').slice(0, 3), ['if stamp_valid; then', 'return 0', 'fi'],
    'the stamp is tested first, before any wait');
  const check = body('stamp_valid');
  assert.equal(check.at(-1), 'return 0');
  for (const line of check.slice(0, -1)) {
    assert.match(line, /^(\[ -f \S+ \]|grep -q '[^']+' \S+ 2>\/dev\/null) \|\| return 1$/,
      `the stamp test only looks at local files: ${line}`);
  }
});

test('a cleanup that outlives the helper does not hold the service lock', { skip: !spawnSync('sh', ['-c', 'command -v flock']).stdout.length && 'no flock on this host' }, async () => {
  // procd.sh takes this service's lock on fd 1000 for the whole init call
  // (`exec 1000>/var/lock/procd_tailscale.lock; flock 1000`). Here the kill is
  // a no-op, so the stand-in survives the helper, as a cleanup stuck past
  // SIGKILL does; a later init call must still get the lock.
  const fixture = makeFixture('lock', { hang: true });
  const lock = path.join(fixture.dir, 'procd_tailscale.lock');
  let pid = null;
  try {
    // A probe a second into the wait: the init's own shell must still hold
    // the lock then, so only the background runner dropped it, not the
    // start_service that procd's lock protects.
    const probe = `( exec 1000>&-; sleep 1; if flock -n "$FIXTURE/procd_tailscale.lock" true; then echo free; else echo held; fi >"$FIXTURE/probe" ) &`;
    const run = runHelper(fixture, LIMIT, `exec 1000>"$FIXTURE/procd_tailscale.lock"; flock 1000\n${probe}\nkill() { return 0; }\n`);
    pid = run.standinPid;
    assert.ok(pid > 0, 'the stand-in started');
    assert.equal(alive(pid), true, 'the cleanup outlived the helper');
    assert.match(run.log, /continuing without it/);
    assert.equal(fs.readFileSync(path.join(fixture.dir, 'probe'), 'utf8').trim(), 'held',
      'the init keeps the lock while it waits for the cleanup');
    // The next `/etc/init.d/tailscale restart` takes the same lock.
    const next = spawnSync('flock', ['-w', '3', lock, 'true'], { stdio: 'ignore', timeout: 10_000 });
    assert.equal(next.status, 0, 'a later init call gets the lock while the cleanup still runs');
  } finally { stop(pid); fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});
