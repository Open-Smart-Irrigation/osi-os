'use strict';

// NEW-23: a gateway installed on a stock base has no /etc/config/osi-server.
// The deploy creates its section "cloud" from the image's own
// 96_osi_server_config before it replaces anything, and changes nothing where
// the section exists. The uci stand-in fails like the real one on a missing
// package or section ("uci: Entry not found", exit 1) and accepts a set on a
// package file that exists, empty or not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');
const DEFAULTS_REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config';

const made = [];
process.on('exit', () => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function extractFunction(name) {
  const open = new RegExp(`^${name}\\(\\) \\{$`, 'm').exec(DEPLOY);
  assert.ok(open, `deploy.sh is missing ${name}()`);
  const close = DEPLOY.indexOf('\n}\n', open.index);
  return DEPLOY.slice(open.index, close + 3);
}

// A stand-in for OpenWrt's uci on a stock base: one JSON file per package
// under <dir>/etc/config. A package whose file does not exist cannot be set
// or read; an existing file (also an empty one, as `touch` makes) can.
const UCI_STANDIN = String.raw`
const fs = require('fs'); const path = require('path');
const dir = process.env.UCI_CONFIG_DIR;
fs.appendFileSync(process.env.UCI_LOG, process.argv.slice(2).join(' ') + '\n');
let args = process.argv.slice(2);
const quiet = args[0] === '-q'; if (quiet) args = args.slice(1);
const fail = () => { if (!quiet) process.stderr.write('uci: Entry not found\n'); process.exit(1); };
const file = (pkg) => path.join(dir, pkg);
const load = (pkg) => { const t = fs.readFileSync(file(pkg), 'utf8').trim(); return t ? JSON.parse(t) : {}; };
const save = (pkg, data) => fs.writeFileSync(file(pkg), JSON.stringify(data, null, 1) + '\n');
function run(cmd, arg) {
  if (cmd === 'commit') { if (!fs.existsSync(file(arg))) fail(); return; }
  if (cmd === 'get') {
    const [pkg, sec, opt] = arg.split('.');
    if (!fs.existsSync(file(pkg))) fail();
    const data = load(pkg); if (!data[sec]) fail();
    if (opt === undefined) { process.stdout.write(data[sec]['.type'] + '\n'); return; }
    if (!(opt in data[sec])) fail();
    process.stdout.write(data[sec][opt] + '\n'); return;
  }
  if (cmd === 'set' || cmd === 'delete') {
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg : arg.slice(0, eq);
    const value = eq < 0 ? '' : arg.slice(eq + 1).replace(/^'(.*)'$/, '$1');
    const [pkg, sec, opt] = key.split('.');
    if (!fs.existsSync(file(pkg))) fail();
    const data = load(pkg);
    if (cmd === 'delete') { if (!data[sec]) fail(); if (opt === undefined) delete data[sec]; else delete data[sec][opt]; save(pkg, data); return; }
    if (opt === undefined) { data[sec] = Object.assign(data[sec] || {}, { '.type': value }); save(pkg, data); return; }
    if (!data[sec]) fail();
    data[sec][opt] = value; save(pkg, data); return;
  }
  process.stderr.write('uci stand-in: unsupported ' + cmd + '\n'); process.exit(2);
}
if (args[0] === 'batch') {
  for (const line of fs.readFileSync(0, 'utf8').split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(.*)$/); if (!m) continue; run(m[1], m[2]);
  }
} else run(args[0], args[1]);
`;

// A gateway: <root>/etc/config (the uci packages), a BASE whose
// 96_osi_server_config is the repository's own, pointed at <root>.
function gateway({ file = false, section = null } = {}) {
  const root = tempDir('osi-new23-');
  const configDir = path.join(root, 'etc', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  if (file) fs.writeFileSync(path.join(configDir, 'osi-server'), section ? `${JSON.stringify(section, null, 1)}\n` : '');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'uci-standin.js'), UCI_STANDIN);
  fs.writeFileSync(path.join(bin, 'uci'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, 'uci-standin.js'))} "$@"\n`, { mode: 0o755 });
  const base = path.join(root, 'base');
  const defaults = fs.readFileSync(path.join(REPO, DEFAULTS_REL), 'utf8')
    .split('/etc/config/').join(`${configDir}/`)
    .split('/usr/libexec/osi-gateway-identity.sh').join(path.join(root, 'no-identity-helper.sh'));
  fs.mkdirSync(path.dirname(path.join(base, DEFAULTS_REL)), { recursive: true });
  fs.writeFileSync(path.join(base, DEFAULTS_REL), defaults);
  return { root, configDir, bin, base, log: path.join(root, 'uci.log') };
}

function shell(g, body) {
  const tmp = tempDir('osi-new23-tmp-');
  const script = `set -eu
BASE=file://${g.base}
TMP_DIR=${JSON.stringify(tmp)}
${extractFunction('fetch')}
${extractFunction('ensure_osi_server_config')}
${extractFunction('ensure_journal_media_defaults')}
${body}
`;
  return spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: `${g.bin}:/usr/bin:/bin`, UCI_CONFIG_DIR: g.configDir, UCI_LOG: g.log },
  });
}

function config(g) {
  const file = path.join(g.configDir, 'osi-server');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : null;
}

test('the uci stand-in fails like uci on a stock base: no package, no section', () => {
  const g = gateway();
  const run = spawnSync(path.join(g.bin, 'uci'), ['set', 'osi-server.cloud.enabled=0'], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', UCI_CONFIG_DIR: g.configDir, UCI_LOG: g.log },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /uci: Entry not found/);
});

test('without the configuration file, the journal defaults end the deploy (the defect before the fix)', () => {
  const g = gateway();
  const run = shell(g, 'ensure_journal_media_defaults\necho reached-past-journal-defaults');
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stdout, /reached-past-journal-defaults/);
});

for (const [name, state] of [
  ['no configuration file', {}],
  ['the file present, the section missing', { file: true }],
]) {
  test(`${name}: the image's defaults create the section, and the journal defaults then succeed`, () => {
    const g = gateway(state);
    const run = shell(g, 'ensure_osi_server_config\nensure_journal_media_defaults\necho done');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /OK: osi-server configuration created/);
    const cloud = config(g).cloud;
    assert.equal(cloud['.type'], 'osi_server');
    assert.equal(cloud.enabled, '0');
    assert.equal(cloud.device_type, 'GATEWAY');
    assert.equal(cloud.device_eui, '', 'the identity stays empty until osi-identityd persists it');
    assert.equal(cloud.journal_media_root, '/data/journal-media');
    assert.equal(cloud.weather_provider_default, 'open_meteo');
    assert.equal('firmware_version' in cloud, false, 'the version is written at the switch, not before');
  });
}

test('a gateway that has the section keeps every value', () => {
  const section = { cloud: { '.type': 'osi_server', enabled: '1', server_host: 'server.example.invalid', firmware_version: '0.8.0',
    device_eui: '0016C001F1000001', journal_media_root: '/mnt/journal', journal_photo_cache_bytes: '1', journal_min_free_bytes: '2' } };
  const g = gateway({ file: true, section });
  const before = fs.readFileSync(path.join(g.configDir, 'osi-server'));
  const run = shell(g, 'ensure_osi_server_config\nensure_journal_media_defaults');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /osi-server configuration present; left as it is/);
  assert.deepEqual(fs.readFileSync(path.join(g.configDir, 'osi-server')), before);
  assert.doesNotMatch(fs.readFileSync(g.log, 'utf8'), /^(set|batch|delete)/m);
});

test('deploy.sh creates the configuration before it replaces settings.js and writes the journal defaults', () => {
  const create = DEPLOY.indexOf('\nensure_osi_server_config || exit 1\n');
  const settings = DEPLOY.indexOf('fetch_required "Node-RED settings.js"');
  const journal = DEPLOY.indexOf('\nensure_journal_media_defaults\n');
  assert.ok(create > 0 && create < settings && settings < journal);
});

test('the bundle path carries the defaults script: deploy-offline.sh runs the bundled deploy.sh', () => {
  const { computeFetchList } = require('./deploy-fetch-list');
  assert.ok(computeFetchList(REPO).includes(DEFAULTS_REL));
  const launcher = fs.readFileSync(path.join(REPO, 'scripts', 'deploy-offline.sh'), 'utf8');
  const supervisor = fs.readFileSync(path.join(REPO, 'scripts', 'deploy-offline-runtime.js'), 'utf8');
  assert.ok(launcher.includes('exec node "$script_dir/deploy-offline-runtime.js" "$@"'), 'launcher delegates to the trusted supervisor');
  const verified = supervisor.indexOf('const tree = verifiedBundle(bytes)');
  const execute = supervisor.indexOf("child.stdin.end(tree.files.get('deploy.sh'))");
  assert.ok(verified >= 0 && execute > verified, 'the bundled script executes from the verified byte snapshot');
});
