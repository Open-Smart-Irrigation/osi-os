'use strict';

// NEW-27: neither gateway base has stat(1), and every deploy after the first
// stopped on it, the retry after a cut included. This test keeps the next
// such command out of the deploy:
// - deploy.sh checks its commands before it changes anything, and its list
//   stays inside what both bases carry (helpers/gateway-base-commands.js);
// - the gateway-side scripts use no command absent on a base, and no tr
//   character class (BusyBox there has none);
// - the deploy's shell paths for a second deploy and for the retry run with
//   a PATH that holds only the bases' commands, and a tr that refuses a
//   character class as the bases' tr would get it wrong.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BASE_COMMANDS, INSTALLED_BY_DEPLOY, ABSENT_ON_BOTH } = require('./helpers/gateway-base-commands');

const REPO = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');
const P = 'conf/full_raspberrypi_bcm27xx_bcm2712/files';
const GATEWAY_SIDE = [
  'deploy.sh',
  'scripts/deploy-offline.sh',
  'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init',
  `${P}/etc/init.d/osi-bootstrap`,
  `${P}/etc/init.d/osi-identityd`,
  `${P}/usr/libexec/osi-gateway-identity.sh`,
  `${P}/usr/libexec/osi-identityd.sh`,
  `${P}/etc/hotplug.d/ntp/70-osi-irrigation-clock`,
  `${P}/etc/uci-defaults/94_osi_identityd_enable`,
  `${P}/etc/uci-defaults/95_osi_bootstrap_enable`,
  `${P}/etc/uci-defaults/96_osi_server_config`,
];

const made = [];
process.on('exit', () => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

function findOnHost(name) {
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH || '').split(':'), '/usr/bin', '/bin', '/usr/sbin'];
  for (const dir of dirs) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch (_) { /* next */ }
  }
  return null;
}

// A directory holding exactly the bases' commands: the host's program where
// it has one, else a stand-in that succeeds (uci, ubus, opkg, logread and
// jsonfilter exist only on OpenWrt; the harnesses stub what they rely on).
function basePath({ without = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-gateway-path-'));
  made.push(dir);
  for (const name of [...BASE_COMMANDS, ...INSTALLED_BY_DEPLOY]) {
    if (without.includes(name)) continue;
    const target = path.join(dir, name);
    if (name === 'tr') {
      const real = findOnHost('tr');
      fs.writeFileSync(target, `#!/bin/sh
for arg in "$@"; do
  case "$arg" in *'[:'*':]'*) echo "tr: character classes are not compiled in on the gateway bases: $arg" >&2; exit 97 ;; esac
done
exec ${real} "$@"
`, { mode: 0o755 });
      continue;
    }
    const host = findOnHost(name === 'ash' ? 'sh' : name);
    if (host) fs.symlinkSync(host, target);
    else fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return dir;
}

function fragment(begin, end) {
  const a = DEPLOY.indexOf(begin);
  const b = DEPLOY.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `deploy.sh is missing ${begin}`);
  return DEPLOY.slice(a, b);
}

function requiredCommands() {
  const m = /^GATEWAY_REQUIRED_COMMANDS="([^"]*)"$/m.exec(DEPLOY);
  assert.ok(m, 'deploy.sh lists GATEWAY_REQUIRED_COMMANDS');
  return m[1].split(/\s+/).filter(Boolean);
}

test('the deploy\'s command list stays inside what both bases carry', () => {
  for (const name of requiredCommands()) {
    assert.ok(BASE_COMMANDS.includes(name), `${name} is not on both gateway bases`);
    assert.ok(!ABSENT_ON_BOTH.includes(name), name);
  }
});

test('the command check runs before the deploy creates its first directory', () => {
  const check = DEPLOY.indexOf('\ncheck_gateway_commands || exit 1\n');
  const firstMkdir = DEPLOY.indexOf('\nmkdir -p "$TMP_DIR"');
  assert.ok(check > 0 && check < firstMkdir);
});

function runCheck(binDir) {
  const script = `${fragment('# command check begin', '# command check end').replace('check_gateway_commands || exit 1', '')}
check_gateway_commands && echo CHECK_PASSED`;
  return spawnSync(path.join(binDir, 'sh'), ['-c', script], { encoding: 'utf8', env: { PATH: binDir } });
}

test('on a base\'s PATH the command check passes; a missing command refuses by name', () => {
  const ok = runCheck(basePath());
  assert.match(ok.stdout, /CHECK_PASSED/, ok.stderr);
  for (const name of ['curl', 'logread', 'node', 'uci', 'wget']) {
    const run = runCheck(basePath({ without: [name] }));
    assert.doesNotMatch(run.stdout, /CHECK_PASSED/);
    assert.match(run.stderr, new RegExp(`lacks commands the deploy needs: ${name};`));
  }
});

test('sqlite3: present, or opkg there to install it', () => {
  assert.match(runCheck(basePath({ without: ['sqlite3'] })).stdout, /CHECK_PASSED/, 'a stock base before its first deploy');
  const neither = runCheck(basePath({ without: ['sqlite3', 'opkg'] }));
  assert.match(neither.stderr, /sqlite3\(or opkg to install it\)/);
});

// Lines that run on the gateway, without comments and without the text of
// echo/printf lines (messages may name a command).
function codeLines(file) {
  return fs.readFileSync(path.join(REPO, file), 'utf8').split('\n')
    .map((line, i) => ({ line: line.replace(/(^|\s)#.*$/, ''), at: `${file}:${i + 1}` }))
    .filter(({ line }) => line.trim() && !/^\s*(echo|printf)\b/.test(line));
}

test('the gateway side calls no command absent on a base', () => {
  const absent = new RegExp(`(^|[\\s;|&(\`!])(${ABSENT_ON_BOTH.join('|')})\\s`);
  const found = [];
  for (const file of GATEWAY_SIDE) {
    for (const { line, at } of codeLines(file)) if (absent.test(line.replace(/command -v \S+/g, ''))) found.push(`${at}: ${line.trim()}`);
  }
  assert.deepEqual(found, []);
});

test('the gateway side uses no tr character class', () => {
  const found = [];
  for (const file of GATEWAY_SIDE) {
    for (const { line, at } of codeLines(file)) if (/\btr\b[^|;]*\[:[a-z]+:\]/.test(line)) found.push(`${at}: ${line.trim()}`);
  }
  assert.deepEqual(found, []);
  // The check above would catch it; the base PATH's tr refuses it as well.
  const run = spawnSync(path.join(basePath(), 'sh'), ['-c', "printf ' a b' | tr -d '[:space:]'"], { encoding: 'utf8', env: { PATH: basePath() } });
  assert.notEqual(run.status, 0);
});

// The deploy's shell paths of a second deploy and of a retry, run by their
// own harnesses with only the bases' commands on PATH.
for (const [file, pattern] of [
  ['scripts/test-conditional-irrigation-clock-install.js', ''],
  ['scripts/deploy-payload-lifecycle.test.js', 'owed check|a retry after a kill|v0.8.1 or v0.7.0 gateway|kill after each step|after the migration commit|held by the old positional check'],
]) {
  test(`with only the bases' commands on PATH: ${path.basename(file)}${pattern ? ` (${pattern})` : ''}`, () => {
    const args = ['--test', '--test-concurrency=1'];
    if (pattern) args.push(`--test-name-pattern=${pattern}`);
    const run = spawnSync(process.execPath, [...args, path.join(REPO, file)], {
      encoding: 'utf8',
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST'))), OSI_TEST_GATEWAY_PATH: basePath() },
      timeout: 20 * 60 * 1000,
    });
    assert.equal(run.status, 0, `${run.stdout.split('\n').filter((l) => /^not ok|# (pass|fail)/.test(l)).join('\n')}\n${run.stderr.slice(-2000)}`);
    assert.match(run.stdout, /# pass [1-9]/);
  });
}
