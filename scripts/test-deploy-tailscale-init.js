'use strict';
// install_tailscale_init() replaces the tailscale package init with the OSI
// copy, and moves its boot link to S99, only under conditions the deploy
// promises to keep: the package file is replaced only while it still is the
// 1.80.3-r1 package file; a refused or failed install leaves the old init
// untouched with one WARN that says the boot protection was not installed
// and why; a disabled service stays disabled; tailscale is never restarted;
// and the step never fails the deploy. The function runs here under the
// deploy's own `set -eu`, with its real file_sha256(); only fetch() and
// sync() are stand-ins, so the host downloads nothing and flushes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const deploy = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');

function between(begin, end, from = 0) {
  const a = deploy.indexOf(begin, from);
  const b = deploy.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `deploy.sh is missing ${begin}`);
  return deploy.slice(a, b);
}

const installerStart = deploy.indexOf('TAILSCALE_INIT="${TAILSCALE_INIT:-/etc/init.d/tailscale}"');
const installerSource = deploy.slice(installerStart, deploy.indexOf('\n# Closing-banner note on ChirpStack provisioning', installerStart));
const shaSource = between('file_sha256() {', '\n}\n') + '\n}\n';
const INIT = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/tailscale');
const PACKAGE_INIT = path.join(root, 'scripts/fixtures/tailscale-package-init/1.80.3-r1.init');
const SRC = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/tailscale';
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pin = (name) => {
  const match = new RegExp(`^${name}="([0-9a-f]{64})"$`, 'm').exec(installerSource);
  assert.ok(match, `deploy.sh pins ${name}`);
  return match[1];
};
const NOT_INSTALLED = 'WARN: tailscale boot protection NOT installed: ';

test('deploy.sh installs the tailscale init as the last step before the closing banner', () => {
  assert.ok(installerStart > 0, 'deploy.sh defines the tailscale init installer');
  const call = deploy.indexOf('\ninstall_tailscale_init\n', installerStart);
  const complete = deploy.indexOf('echo "=== Deploy complete. ==="');
  assert.ok(call > 0 && call < complete, 'install_tailscale_init runs before "Deploy complete"');
  const health = deploy.indexOf('# self-check verdict end');
  assert.ok(health > 0 && health < call, 'it runs only after the payload health check, so a refused or rolled-back deploy never touches the init');
  const step = deploy.slice(deploy.indexOf('echo "--- Tailscale boot init ---"', installerStart), call);
  assert.equal(step, 'echo "--- Tailscale boot init ---"\ntailscale_init_warning=""', 'the warning is cleared right before the call');
  assert.match(deploy.slice(complete),
    /if \[ -n "\$tailscale_init_warning" \]; then\n    echo "  \$tailscale_init_warning"\n    echo ""\nfi/,
    'the closing banner repeats the warning verbatim');
  assert.equal(deploy.match(/^install_tailscale_init$/gm)?.length, 1);
});

test('the pins are the shipped init and the package file', () => {
  assert.equal(pin('TAILSCALE_INIT_SHA256'), sha256(INIT));
  assert.equal(pin('TAILSCALE_PACKAGE_INIT_SHA256'), sha256(PACKAGE_INIT));
  assert.notEqual(pin('TAILSCALE_INIT_SHA256'), pin('TAILSCALE_PACKAGE_INIT_SHA256'));
});

test('the installer never runs a service command and never fails the deploy', () => {
  assert.match(installerSource, /^install_tailscale_init\(\) \{$/m, 'deploy.sh defines install_tailscale_init');
  const code = installerSource.split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .filter((line) => line.trim() && !/^\s*(echo|printf)\b/.test(line));
  const commands = code.join('\n').match(/(^|[;&|(`]\s*)(restart|stop|start|reload|enable|disable|exit)\b/g) || [];
  assert.deepEqual(commands, []);
  const returns = installerSource.match(/^\s*return [1-9]/gm) || [];
  assert.deepEqual(returns, [], 'every return is a 0');
  // Every warning is one line in one grammar: what is installed, the reason,
  // and the state the gateway is left in.
  const warnings = [...installerSource.matchAll(/tailscale_init_warning="([^"]+)"/g)].map((match) => match[1].replace(/\$\{?\w+\}?/g, 'X'));
  const GRAMMAR = /^WARN: tailscale boot protection (?<status>NOT installed|installed, but NOT moved to S99|installed at S99, but another boot link stays): (?<reason>[^;]+); (?<state>.+)$/;
  assert.equal(warnings.length, 5);
  for (const warning of warnings) {
    assert.match(warning, GRAMMAR, `a warning names what is installed, the reason and the state: ${warning}`);
  }
  assert.deepEqual(warnings.map((warning) => warning.match(GRAMMAR).groups.status),
    ['NOT installed', 'NOT installed', 'NOT installed', 'installed, but NOT moved to S99', 'installed at S99, but another boot link stays']);
  // The fourth "NOT installed" line carries the reason of the step that failed.
  assert.deepEqual([...installerSource.matchAll(/tailscale_init_why="([^"]+)"/g)].map((match) => match[1]),
    ['could not download the OSI init', 'the downloaded init does not match its SHA-256 pin',
     'the downloaded init fails the shell syntax check', 'could not replace the package file']);
});

function makeFixture({ init = 'package', links = ['S80tailscale'], linkDirectory = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-deploy-tailscale-init-'));
  const initDir = path.join(dir, 'etc/init.d');
  const rcDir = path.join(dir, 'etc/rc.d');
  fs.mkdirSync(initDir, { recursive: true });
  fs.mkdirSync(rcDir, { recursive: true });
  const initFile = path.join(initDir, 'tailscale');
  if (init === 'directory') {
    fs.mkdirSync(initFile);
  } else if (init === 'dangling') {
    fs.symlinkSync('/nonexistent/tailscale.init', initFile);
  } else if (init !== 'none') {
    const source = { package: PACKAGE_INIT, ours: INIT, other: null }[init];
    fs.writeFileSync(initFile, source ? fs.readFileSync(source) : '#!/bin/sh /etc/rc.common\n\nUSE_PROCD=1\nSTART=85\n');
    fs.chmodSync(initFile, 0o755);
  }
  for (const link of links) {
    if (linkDirectory) fs.mkdirSync(path.join(rcDir, link));
    else fs.symlinkSync('../init.d/tailscale', path.join(rcDir, link));
  }
  return { dir, initDir, rcDir, initFile, fetchLog: path.join(dir, 'fetch.log') };
}

function snapshot(fixture) {
  const link = (name) => {
    const file = path.join(fixture.rcDir, name);
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isDirectory()) return `${name} is a directory`;
    return fs.lstatSync(file, { throwIfNoEntry: false }) ? `${name} -> ${fs.readlinkSync(file)}` : `${name} absent`;
  };
  return {
    init: fs.existsSync(fixture.initFile) ? { sha: sha256(fixture.initFile), mode: fs.statSync(fixture.initFile).mode & 0o7777 } : null,
    links: ['S80tailscale', 'S85tailscale', 'S99tailscale'].map(link),
    files: fs.readdirSync(fixture.initDir).sort(),
  };
}

function run(fixture, { fetch = 'copy', source = INIT, pathOverride, syncFails, readOnlyRcD = false } = {}) {
  // Output goes to files, not to pipes, so the result does not depend on
  // what the child leaves behind. The warning file is written last inside
  // the subshell: an abort under `set -eu` leaves it unwritten.
  const script = `
(
    set -eu
    tailscale_init_warning=""
    eval "$SHA_SOURCE"
    eval "$INSTALLER_SOURCE"
    fetch() {
        printf '%s\\n' "$1" >>"$FIXTURE/fetch.log"
        [ "$FETCH_MODE" = copy ] || return 22
        cp "$FETCH_SOURCE" "$2"
    }
    sync() {
        printf 'sync %s\\n' "$(file_sha256 "$TAILSCALE_INIT" | cut -c1-12)" >>"$FIXTURE/sync.log"
        [ "$SYNC_FAILS" != all ] || return 5
        # The first sync runs while the stage file exists, the second after the rename.
        if ls "$TAILSCALE_INIT".osi-stage.* >/dev/null 2>&1; then staged=yes; else staged=no; fi
        if [ "$SYNC_FAILS" = before ] && [ "$staged" = yes ]; then return 5; fi
        if [ "$SYNC_FAILS" = after ] && [ "$staged" = no ]; then return 5; fi
        return 0
    }
    install_tailscale_init
    printf '%s' "$tailscale_init_warning" >"$FIXTURE/warning"
) >"$FIXTURE/stdout" 2>"$FIXTURE/stderr"
rc=$?
[ -f "$FIXTURE/warning" ] || printf 'aborted' >"$FIXTURE/warning"
printf '%s' "$rc" >"$FIXTURE/status"
`;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OSI_TEST_'))),
    SHA_SOURCE: shaSource,
    INSTALLER_SOURCE: installerSource,
    FETCH_MODE: fetch,
    FETCH_SOURCE: source,
    FIXTURE: fixture.dir,
    SYNC_FAILS: syncFails || 'never',
    TAILSCALE_INIT: fixture.initFile,
    TAILSCALE_RC_D: fixture.rcDir,
  };
  if (pathOverride) env.PATH = pathOverride;
  else if (process.env.OSI_TEST_GATEWAY_PATH) env.PATH = process.env.OSI_TEST_GATEWAY_PATH;
  let child;
  if (readOnlyRcD) fs.chmodSync(fixture.rcDir, 0o555);
  try {
    child = spawnSync('sh', ['-c', script], { env, stdio: 'ignore', timeout: 60_000 });
  } finally {
    if (readOnlyRcD) fs.chmodSync(fixture.rcDir, 0o755);
  }
  assert.equal(child.error, undefined, child.error && child.message);
  const read = (name) => fs.readFileSync(path.join(fixture.dir, name), 'utf8');
  const warning = read('warning');
  const stderr = read('stderr');
  // The warning is one line at the end of stderr, after any error a failed
  // command printed itself, and it is what the closing banner repeats.
  const warned = stderr.split('\n').filter((line) => line.startsWith('WARN:'));
  if (warning === 'aborted' || warning === '') assert.deepEqual(warned, [], `no warning is printed: ${stderr}`);
  else {
    assert.deepEqual(warned, [warning], 'exactly one WARN line, equal to the one the banner repeats');
    assert.ok(stderr.endsWith(warning + '\n'), 'the WARN is the last line of stderr');
  }
  return {
    status: Number(read('status')),
    warning,
    stdout: read('stdout'),
    stderr,
    fetches: fs.existsSync(fixture.fetchLog) ? fs.readFileSync(fixture.fetchLog, 'utf8').split('\n').filter(Boolean) : [],
    syncs: fs.existsSync(path.join(fixture.dir, 'sync.log')) ? fs.readFileSync(path.join(fixture.dir, 'sync.log'), 'utf8').split('\n').filter(Boolean) : [],
  };
}

const cleanup = (fixture) => fs.rmSync(fixture.dir, { recursive: true, force: true });

// A stand-in sh, first on PATH, that fails every syntax check and runs the
// rest. The pin check comes first in the installer, so a download that fails
// `sh -n` cannot be staged without it.
function pathWithFailingSyntaxCheck(fixture) {
  const bin = path.join(fixture.dir, 'failing-sh');
  fs.mkdirSync(bin);
  const real = fs.realpathSync(spawnSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).stdout.trim());
  fs.writeFileSync(path.join(bin, 'sh'), `#!/bin/sh\n[ "$1" = "-n" ] && exit 2\nexec ${real} "$@"\n`, { mode: 0o755 });
  return `${bin}:${process.env.OSI_TEST_GATEWAY_PATH || process.env.PATH}`;
}
const INSTALLED = 'OK: tailscale starts at S99 from the next boot (after ChirpStack and Node-RED); it was not restarted';
const ONLY_S99 = ['S80tailscale absent', 'S85tailscale absent', 'S99tailscale -> ../init.d/tailscale'];

test('the package file is replaced, published 0755, and its boot link moves from S80 to S99', () => {
  const fixture = makeFixture();
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.warning, '');
    const after = snapshot(fixture);
    assert.equal(after.init.sha, sha256(INIT));
    assert.equal(after.init.mode, 0o755);
    assert.deepEqual(after.links, ONLY_S99);
    assert.deepEqual(after.files, ['tailscale'], 'no stage file is left beside the init');
    assert.deepEqual(result.fetches, [SRC]);
    // On disk complete before it replaces the package file, and durable after.
    assert.deepEqual(result.syncs, [`sync ${sha256(PACKAGE_INIT).slice(0, 12)}`, `sync ${sha256(INIT).slice(0, 12)}`]);
    assert.deepEqual(result.stdout.split('\n').filter(Boolean), [
      'OK: OSI tailscale init installed (cleanup time-limited, START=99)',
      INSTALLED,
    ]);
  } finally { cleanup(fixture); }
});

test('an init the deploy cut between replacing and the link move is completed without a download', () => {
  const fixture = makeFixture({ init: 'ours', links: ['S80tailscale'] });
  try {
    const before = snapshot(fixture);
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.warning, '');
    assert.deepEqual(result.fetches, [], 'nothing is downloaded for a file that is already ours');
    assert.equal(snapshot(fixture).init.sha, before.init.sha);
    assert.deepEqual(snapshot(fixture).links, ONLY_S99);
    assert.equal(result.stdout.trim(), INSTALLED);
  } finally { cleanup(fixture); }
});

test('a second deploy on a finished gateway changes nothing and downloads nothing', () => {
  const fixture = makeFixture({ init: 'ours', links: ['S99tailscale'] });
  try {
    const before = snapshot(fixture);
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.fetches, []);
    assert.deepEqual(snapshot(fixture), before);
    assert.equal(result.warning, '');
  } finally { cleanup(fixture); }
});

test('any other boot position gives way to S99 alone', () => {
  const fixture = makeFixture({ init: 'ours', links: ['S80tailscale', 'S85tailscale'] });
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.warning, '');
    assert.deepEqual(snapshot(fixture).links, ONLY_S99);
  } finally { cleanup(fixture); }
});

test('an init that is neither the package file nor ours is refused: not installed, why, untouched', () => {
  const expected = 'WARN: tailscale boot protection NOT installed: X is neither the tailscale 1.80.3-r1 package file nor the OSI copy; the file was left unchanged';
  for (const [label, options] of [
    ['a newer package', { init: 'other', links: ['S85tailscale'] }],
    ['a locally edited package file', { init: 'other', links: ['S80tailscale'] }],
  ]) {
    const fixture = makeFixture(options);
    try {
      const before = snapshot(fixture);
      const result = run(fixture);
      assert.equal(result.status, 0, `${label}: the deploy is not failed\n${result.stderr}`);
      assert.equal(result.stdout, '', `${label}: nothing is reported as done`);
      assert.deepEqual(snapshot(fixture), before, `${label}: file and links untouched`);
      assert.deepEqual(result.fetches, [], `${label}: nothing is downloaded`);
      assert.deepEqual(result.syncs, [], `${label}: nothing is written or flushed`);
      const warning = expected.replace('X', fixture.initFile);
      assert.equal(result.warning, warning, `${label}: the banner repeats it`);
      assert.equal(result.stderr, warning + '\n', `${label}: one plain line`);
    } finally { cleanup(fixture); }
  }
});

test('a gateway without tailscale gets nothing', () => {
  for (const init of ['none', 'directory', 'dangling']) {
    const fixture = makeFixture({ init, links: [] });
    try {
      const before = fs.readdirSync(fixture.initDir);
      const result = run(fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.fetches, []);
      assert.deepEqual(result.syncs, []);
      assert.deepEqual(fs.readdirSync(fixture.initDir), before, `${init}: nothing is created beside it`);
      if (init === 'directory') assert.equal(fs.statSync(fixture.initFile).isDirectory(), true);
      if (init === 'dangling') assert.equal(fs.readlinkSync(fixture.initFile), '/nonexistent/tailscale.init');
      assert.equal(result.warning, '');
      assert.equal(result.stdout.trim(), 'OK: tailscale is not installed');
    } finally { cleanup(fixture); }
  }
});

test('a service that is disabled at boot stays disabled', () => {
  const fixture = makeFixture({ init: 'package', links: [] });
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.warning, '');
    assert.equal(snapshot(fixture).init.sha, sha256(INIT));
    assert.deepEqual(snapshot(fixture).links, ['S80tailscale absent', 'S85tailscale absent', 'S99tailscale absent']);
    assert.equal(result.stdout.split('\n').filter(Boolean).at(-1), 'OK: tailscale is disabled at boot; left disabled');
  } finally { cleanup(fixture); }
});

test('a failed download, pin or syntax check, or a failed replacement, says which and keeps the package file', () => {
  for (const [label, options, why] of [
    ['download fails', { fetch: 'fail' }, 'could not download the OSI init'],
    ['download does not match the pin', { source: PACKAGE_INIT }, 'the downloaded init does not match its SHA-256 pin'],
    ['sync fails before the rename', { syncFails: 'all' }, 'could not replace the package file'],
    ['sync fails while the stage exists', { syncFails: 'before' }, 'could not replace the package file'],
  ]) {
    const fixture = makeFixture();
    try {
      const before = snapshot(fixture);
      const result = run(fixture, options);
      assert.equal(result.status, 0, `${label}: the deploy is not failed\n${result.stderr}`);
      assert.equal(result.stdout, '', `${label}: nothing is reported as done`);
      assert.deepEqual(snapshot(fixture), before, `${label}: package file and links untouched`);
      const warning = NOT_INSTALLED + why + '; the package file stays';
      assert.equal(result.warning, warning, `${label}: the banner repeats it`);
      assert.equal(result.stderr, warning + '\n', `${label}: one plain line`);
    } finally { cleanup(fixture); }
  }
});

test('a download that fails the syntax check is not installed, although it matches its pin', () => {
  // An unpinned file fails the pin check first, so a bad syntax check is
  // reached only through the stand-in sh.
  const fixture = makeFixture();
  try {
    const before = snapshot(fixture);
    const result = run(fixture, { pathOverride: pathWithFailingSyntaxCheck(fixture) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(fixture), before);
    const warning = NOT_INSTALLED + 'the downloaded init fails the shell syntax check; the package file stays';
    assert.equal(result.warning, warning);
  } finally { cleanup(fixture); }
});

test('a sync that fails after the replacement fails nothing', () => {
  const fixture = makeFixture();
  try {
    const result = run(fixture, { syncFails: 'after' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.warning, '', 'the file is in place; a failed flush is no deploy failure');
    assert.equal(snapshot(fixture).init.sha, sha256(INIT));
    assert.deepEqual(result.syncs.length, 2);
  } finally { cleanup(fixture); }
});

test('a failed link move says the protection is installed but does not start last', { skip: process.getuid?.() === 0 && 'a read-only directory does not stop root' }, () => {
  const fixture = makeFixture({ init: 'ours', links: ['S80tailscale'] });
  try {
    const result = run(fixture, { readOnlyRcD: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.fetches, []);
    const warning = `WARN: tailscale boot protection installed, but NOT moved to S99: could not create ${fixture.rcDir}/S99tailscale; tailscale keeps its boot position`;
    assert.equal(result.warning, warning);
    // The package position is kept, with the time-limited init in place.
    assert.deepEqual(snapshot(fixture).links, ['S80tailscale -> ../init.d/tailscale', 'S85tailscale absent', 'S99tailscale absent']);
    assert.equal(snapshot(fixture).init.sha, sha256(INIT));
  } finally { cleanup(fixture); }
});

test('an older boot link that cannot be removed says the service starts twice', () => {
  const fixture = makeFixture({ init: 'ours', links: ['S80tailscale'], linkDirectory: true });
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.fetches, []);
    const warning = `WARN: tailscale boot protection installed at S99, but another boot link stays: ${fixture.rcDir}/S80tailscale could not be removed; tailscale starts twice at boot until it is`;
    assert.equal(result.warning, warning);
    assert.deepEqual(snapshot(fixture).links, ['S80tailscale is a directory', 'S85tailscale absent', 'S99tailscale -> ../init.d/tailscale']);
  } finally { cleanup(fixture); }
});
