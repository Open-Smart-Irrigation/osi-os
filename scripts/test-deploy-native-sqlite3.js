#!/usr/bin/env node
'use strict';
// Behavioral proof for deploy.sh's native-sqlite3 handling (F148).
//
// The defect this pins (2026-09-17, re-cut 9 on the Pi 4B rehearsal gateway,
// armv7l + musl, Node 20.18.3 / npm 10.8.2, no Python): deploy.sh stopped with
// exit 1 in its "Node-RED runtime dependencies" step. npm's debug log read
//
//     silly reify mark retired [ '/srv/node-red/node_modules/sqlite3' ]
//     run sqlite3@5.1.7 install ... prebuild-install -r napi || node-gyp rebuild
//     No prebuilt binaries found (target=6 runtime=napi arch=arm libc=musl ...)
//
// On a stock image /srv/node-red/node_modules/sqlite3 is a SYMLINK into the
// opkg package node-red-node-sqlite (conf/*/files/etc/uci-defaults/
// 98_osi_node_red_seed), because that cross-compiled binary is the only
// sqlite3 built for the gateway's CPU. The shipped package-lock.json declares
// sqlite3 as an ordinary REGISTRY dependency, so npm's arborist finds a Link
// where the lockfile says registry, marks the path CHANGE, retires the
// symlink and re-extracts the tarball -- which has no binary in it and whose
// install script then tries to build one. The osi-* modules survive the same
// deploy because the lockfile declares THEM as links too ("file:" deps).
//
// Nothing here paraphrases that mechanism. Tests 1 and 2 run REAL npm,
// offline, against a fixture package literally named sqlite3@5.1.7 whose
// index.js throws the way sqlite3's own does when build/Release/
// node_sqlite3.node is missing, and observe what npm does to a symlink versus
// a real directory. Tests 3 onward extract the ACTUAL shell text of
// deploy.sh's materialise / preflight / verify functions and run them with
// real sh and real node, the same technique
// scripts/test-deploy-reconcile-probe.js uses for the nested reconcile probe.
//
// Offline: every dependency is a local `file:` tarball and npm runs with
// --offline against a scratch cache, so no test here touches the registry.
// Install scripts are deliberately no-ops (npm 12 blocks unapproved install
// scripts, npm 10 runs them) so the assertions are the same on every npm the
// repo is exercised with; what is asserted is the tree npm leaves behind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');

const LOCKED_VERSION = '5.1.7';
const BINDING_REL = path.join('build', 'Release', 'node_sqlite3.node');

// --- deploy.sh text extraction ---------------------------------------------

// Pulls one shell function's full source out of deploy.sh. deploy.sh indents
// function bodies and closes every function with a `}` in column 0, so that is
// the terminator. Same extractor as scripts/test-deploy-fresh-install.js.
function extractFunction(name) {
  const open = new RegExp(String.raw`^${name}\(\) \{$`, 'm').exec(DEPLOY);
  assert.ok(open, `deploy.sh is missing the ${name}() function`);
  const close = DEPLOY.indexOf('\n}\n', open.index);
  assert.notEqual(close, -1, `deploy.sh's ${name}() has no column-0 closing brace`);
  return DEPLOY.slice(open.index, close + 3);
}

// --- fixtures ---------------------------------------------------------------

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-native-sqlite3-'));
const NPM_CACHE = path.join(SCRATCH, 'npm-cache');
fs.mkdirSync(NPM_CACHE, { recursive: true });

process.on('exit', () => {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
});

function npm(args, cwd) {
  return spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: NPM_CACHE,
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      npm_config_update_notifier: 'false',
    },
  });
}

// A stand-in for sqlite3@5.1.7: same name, same version, same shape of
// failure. index.js requires a peer package (standing in for sqlite3's
// `require('bindings')`, which is NOT vendored inside the module) and then
// insists on build/Release/node_sqlite3.node, which is exactly what the
// published tarball does not carry and the cross-compiled opkg module does.
function writeFixtureSources(dir) {
  const sqliteSrc = path.join(dir, 'src-sqlite3');
  fs.mkdirSync(path.join(sqliteSrc, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(sqliteSrc, 'package.json'), JSON.stringify({
    name: 'sqlite3',
    version: LOCKED_VERSION,
    main: 'index.js',
    // sqlite3's real install script is
    //   prebuild-install -r napi || node-gyp rebuild
    // Here it is a no-op: npm 12 blocks unapproved install scripts and npm 10
    // runs them, and this test asserts on the TREE npm leaves behind, which is
    // identical either way.
    scripts: { install: 'node -e ""' },
  }, null, 2));
  fs.writeFileSync(path.join(sqliteSrc, 'index.js'), [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "// stands in for sqlite3's require('bindings')('node_sqlite3.node')",
    "require('fixture-peer');",
    "const binding = path.join(__dirname, 'build', 'Release', 'node_sqlite3.node');",
    'if (!fs.existsSync(binding)) {',
    "  throw new Error('Could not locate the bindings file. Tried: ' + binding);",
    '}',
    'function Database(filename, cb) {',
    '  this.filename = filename;',
    "  if (typeof cb === 'function') process.nextTick(function () { cb(null); });",
    '}',
    'Database.prototype.close = function (cb) {',
    "  if (typeof cb === 'function') process.nextTick(function () { cb(null); });",
    '};',
    "module.exports = { Database: Database, VERSION: '3.44.2' };",
    '',
  ].join('\n'));

  const peerSrc = path.join(dir, 'src-fixture-peer');
  fs.mkdirSync(peerSrc, { recursive: true });
  fs.writeFileSync(path.join(peerSrc, 'package.json'), JSON.stringify({
    name: 'fixture-peer', version: '1.0.0', main: 'index.js',
  }, null, 2));
  fs.writeFileSync(path.join(peerSrc, 'index.js'), "module.exports = { peer: true };\n");

  const packed = {};
  for (const [name, src] of [['sqlite3', sqliteSrc], ['fixture-peer', peerSrc]]) {
    const r = npm(['pack', src, '--pack-destination', dir], dir);
    assert.equal(r.status, 0, `npm pack ${name} failed: ${r.stderr}`);
    const tgz = r.stdout.trim().split('\n').pop().trim();
    assert.ok(fs.existsSync(path.join(dir, tgz)), `npm pack ${name} produced no ${tgz}`);
    packed[name] = tgz;
  }
  return packed;
}

// Builds a gateway-shaped fixture:
//
//   <root>/firmware/node_modules/fixture-peer      (the firmware tree's peers)
//   <root>/firmware/node_modules/node-red-node-sqlite/node_modules/sqlite3
//                                                 (+ build/Release binary)
//   <root>/node-red/                              (stands in for /srv/node-red)
//
// `state` picks which of the six states from the PR's state table the
// gateway is in when npm (or deploy.sh) reaches it.
function makeGateway(state) {
  const root = fs.mkdtempSync(path.join(SCRATCH, 'gw-'));
  const packed = writeFixtureSources(root);

  // --- the firmware (opkg) tree -------------------------------------------
  const fwModules = path.join(root, 'firmware', 'node_modules');
  const fwSqlite = path.join(fwModules, 'node-red-node-sqlite', 'node_modules', 'sqlite3');
  fs.mkdirSync(fwSqlite, { recursive: true });
  extractTarball(path.join(root, packed.sqlite3), fwSqlite);
  writeBinding(fwSqlite);
  // The firmware tree carries its own peers, which is why the SYMLINK loads
  // today even though /srv/node-red may not have them yet.
  fs.mkdirSync(path.join(fwModules, 'fixture-peer'), { recursive: true });
  extractTarball(path.join(root, packed['fixture-peer']), path.join(fwModules, 'fixture-peer'));

  // --- /srv/node-red -------------------------------------------------------
  const proj = path.join(root, 'node-red');
  fs.mkdirSync(proj, { recursive: true });
  for (const tgz of Object.values(packed)) {
    fs.copyFileSync(path.join(root, tgz), path.join(proj, tgz));
  }
  fs.mkdirSync(path.join(proj, 'osi-fixture-helper'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'osi-fixture-helper', 'package.json'), JSON.stringify({
    name: 'osi-fixture-helper', version: '1.0.0', main: 'index.js',
  }, null, 2));
  fs.writeFileSync(path.join(proj, 'osi-fixture-helper', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({
    name: 'osi-node-red-fixture',
    version: '1.0.0',
    private: true,
    dependencies: {
      // sqlite3 is a REGISTRY-shaped dependency (a tarball, not a directory),
      // exactly as the shipped lockfile declares it.
      sqlite3: `file:${packed.sqlite3}`,
      'fixture-peer': `file:${packed['fixture-peer']}`,
      // ...while the osi-* helpers are directory deps, which the lockfile
      // records as links. This is the contrast that makes them survive.
      'osi-fixture-helper': 'file:osi-fixture-helper',
    },
  }, null, 2));

  const install = npm(['install', '--offline', '--no-fund', '--no-audit'], proj);
  assert.equal(install.status, 0, `fixture npm install failed: ${install.stderr}`);

  const lock = JSON.parse(fs.readFileSync(path.join(proj, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/sqlite3'].version, LOCKED_VERSION,
    'fixture lockfile does not pin sqlite3 ' + LOCKED_VERSION);
  assert.ok(!lock.packages['node_modules/sqlite3'].link,
    'fixture lockfile must declare sqlite3 as a registry-shaped package, not a link');
  assert.ok(lock.packages['node_modules/osi-fixture-helper'].link,
    'fixture lockfile must declare osi-fixture-helper as a link');

  const sqlitePath = path.join(proj, 'node_modules', 'sqlite3');
  fs.rmSync(sqlitePath, { recursive: true, force: true });
  switch (state) {
    case 'firmware-symlink':
      fs.symlinkSync(fwSqlite, sqlitePath);
      break;
    case 'real-with-binary':
      copyDir(fwSqlite, sqlitePath);
      break;
    case 'real-without-binary':
      // what npm's own extraction leaves behind: the tarball, no binary
      fs.mkdirSync(sqlitePath, { recursive: true });
      extractTarball(path.join(proj, packed.sqlite3), sqlitePath);
      break;
    case 'dangling-symlink':
      fs.symlinkSync(path.join(root, 'firmware-that-was-removed', 'sqlite3'), sqlitePath);
      break;
    case 'absent':
      break;
    default:
      throw new Error(`unknown gateway state ${state}`);
  }

  // deploy.sh copies the osi-* module sources in before npm runs, which makes
  // node_modules/.package-lock.json stale and forces arborist to read the tree
  // off disk. Mirror that so the fixture npm run is the gateway's npm run.
  fs.writeFileSync(path.join(proj, 'osi-fixture-helper', 'index.js'), 'module.exports = 2;\n');
  fs.utimesSync(path.join(proj, 'node_modules'), new Date(), new Date());

  return { root, proj, fwSqlite, fwModules, tarballs: packed };
}

function extractTarball(tgz, dest) {
  const r = spawnSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `tar -xzf ${tgz} failed: ${r.stderr}`);
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function writeBinding(moduleDir) {
  const binding = path.join(moduleDir, BINDING_REL);
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  // Stands in for the cross-compiled .node the opkg package ships. Its
  // presence is what the fixture module checks, so a text file is enough and
  // the test stays portable across CPUs.
  fs.writeFileSync(binding, 'cross-compiled-firmware-binary\n');
}

function hasBinding(moduleDir) {
  return fs.existsSync(path.join(moduleDir, BINDING_REL));
}

function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function npmInstallLikeDeploy(proj) {
  // byte-for-byte the flags deploy.sh uses, plus --offline so the test never
  // reaches the network.
  return npm(['install', '--omit=dev', '--no-fund', '--no-audit', '--offline'], proj);
}

function requireSqlite3(proj) {
  return spawnSync(process.execPath, ['-e', [
    "const sqlite3 = require('sqlite3');",
    "const db = new sqlite3.Database(':memory:', function (err) {",
    '  if (err) { console.error(String(err)); process.exit(1); }',
    '  db.close(function () { process.exit(0); });',
    '});',
  ].join('\n')], { cwd: proj, encoding: 'utf8' });
}

// --- shell harness ----------------------------------------------------------

function shellHarness(gw, body, opts = {}) {
  const tmp = path.join(gw.root, 'deploy-tmp');
  fs.mkdirSync(tmp, { recursive: true });
  // `firmware: false` stands for a gateway whose opkg module is gone, so the
  // canonical path deploy.sh would restore from does not exist.
  const firmwareDir = opts.firmware === false
    ? path.join(gw.root, 'firmware-that-was-removed', 'sqlite3')
    : gw.fwSqlite;
  const preamble = [
    'set -eu',
    `NODE_RED_ROOT=${JSON.stringify(gw.proj)}`,
    `NATIVE_SQLITE3_FIRMWARE_DIR=${JSON.stringify(firmwareDir)}`,
    `TMP_DIR=${JSON.stringify(tmp)}`,
    `NATIVE_ARCH=${JSON.stringify(opts.arch || 'armv7l')}`,
    `MUSL_LOADER_GLOB=${JSON.stringify(opts.muslGlob || path.join(gw.root, 'fake-libc', 'ld-musl-*.so.1'))}`,
  ];
  if (opts.lockFixture) {
    // deploy.sh curls the shipped lockfile through the SSH tunnel; here the
    // preflight gets a fixture straight off disk.
    preamble.push(`fetch() { mkdir -p "$(dirname "$2")"; cp ${JSON.stringify(opts.lockFixture)} "$2"; }`);
  }
  const script = [
    ...preamble,
    extractFunction('native_sqlite3_dir_loads'),
    extractFunction('native_build_toolchain_present'),
    extractFunction('native_sqlite3_reinstall_impossible'),
    extractFunction('run_native_sqlite3_preflight'),
    extractFunction('materialize_native_sqlite3'),
    extractFunction('verify_native_sqlite3_after_npm'),
    opts.toolchain === false
      ? 'native_build_toolchain_present() { return 1; }'
      : (opts.toolchain === true ? 'native_build_toolchain_present() { return 0; }' : ''),
    body,
  ].join('\n');
  return spawnSync('sh', ['-c', script], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// 1 + 2: what real npm does. These two pass on the broken main as well: they
// are the mechanism, not the fix.
// ---------------------------------------------------------------------------

test('npm retires a symlinked sqlite3 and re-extracts it, losing the firmware binary', () => {
  const gw = makeGateway('firmware-symlink');
  const sqlitePath = path.join(gw.proj, 'node_modules', 'sqlite3');

  assert.ok(isSymlink(sqlitePath), 'fixture did not start as a symlink');
  assert.ok(hasBinding(sqlitePath), 'the firmware module should carry the native binary');
  assert.equal(requireSqlite3(gw.proj).status, 0, 'the symlinked firmware module should load before npm runs');

  const r = npmInstallLikeDeploy(gw.proj);
  assert.equal(r.status, 0, `fixture npm install failed: ${r.stderr}`);

  assert.equal(isSymlink(sqlitePath), false,
    'npm should have replaced the symlink with its own extraction');
  assert.equal(hasBinding(sqlitePath), false,
    'the re-extracted tarball must not carry a native binary -- this is the reinstall that runs node-gyp on the gateway');
  assert.notEqual(requireSqlite3(gw.proj).status, 0,
    "require('sqlite3') should now fail: npm threw away the only binary built for this CPU");

  // ...while the osi-* link the lockfile also declares as a link is untouched.
  assert.ok(isSymlink(path.join(gw.proj, 'node_modules', 'osi-fixture-helper')),
    'npm should have left the osi-* link alone');
});

test('npm leaves a real sqlite3 directory at the locked version alone', () => {
  const gw = makeGateway('real-with-binary');
  const sqlitePath = path.join(gw.proj, 'node_modules', 'sqlite3');

  assert.equal(isSymlink(sqlitePath), false, 'fixture should start as a real directory');
  fs.writeFileSync(path.join(sqlitePath, 'OSI_SENTINEL'), 'untouched\n');

  const r = npmInstallLikeDeploy(gw.proj);
  assert.equal(r.status, 0, `fixture npm install failed: ${r.stderr}`);

  assert.ok(fs.existsSync(path.join(sqlitePath, 'OSI_SENTINEL')),
    'npm should not have retired a real directory whose version matches the lockfile');
  assert.ok(hasBinding(sqlitePath), 'the native binary should still be there');
  assert.equal(requireSqlite3(gw.proj).status, 0, "require('sqlite3') should still work");
});

// ---------------------------------------------------------------------------
// 3+: deploy.sh's own shell text.
// ---------------------------------------------------------------------------

test('materialize_native_sqlite3 turns the firmware symlink into a real directory that survives npm', () => {
  const gw = makeGateway('firmware-symlink');
  const sqlitePath = path.join(gw.proj, 'node_modules', 'sqlite3');

  const r = shellHarness(gw, 'materialize_native_sqlite3');
  assert.equal(r.status, 0, `materialize_native_sqlite3 failed: ${r.stdout}${r.stderr}`);
  assert.equal(isSymlink(sqlitePath), false, 'sqlite3 should now be a real directory');
  assert.ok(hasBinding(sqlitePath), 'the materialised copy must carry the firmware binary');
  assert.match(r.stdout, /materialised/);

  const install = npmInstallLikeDeploy(gw.proj);
  assert.equal(install.status, 0, `npm install failed after materialising: ${install.stderr}`);

  assert.ok(hasBinding(sqlitePath),
    'npm must leave the materialised native module alone -- this is the whole fix');
  assert.equal(requireSqlite3(gw.proj).status, 0, "require('sqlite3') should work after npm install");

  const verify = shellHarness(gw, 'verify_native_sqlite3_after_npm');
  assert.equal(verify.status, 0, `verify_native_sqlite3_after_npm failed: ${verify.stdout}${verify.stderr}`);

  // ...and the temporary staging directory is not left behind in node_modules.
  const strays = fs.readdirSync(path.join(gw.proj, 'node_modules')).filter((n) => n.startsWith('.osi-sqlite3'));
  assert.deepEqual(strays, [], `materialise left staging directories behind: ${strays.join(', ')}`);
});

test('materialize_native_sqlite3 is a no-op the second time', () => {
  const gw = makeGateway('firmware-symlink');
  const sqlitePath = path.join(gw.proj, 'node_modules', 'sqlite3');

  assert.equal(shellHarness(gw, 'materialize_native_sqlite3').status, 0);
  fs.writeFileSync(path.join(sqlitePath, 'OSI_SENTINEL'), 'first run\n');

  const second = shellHarness(gw, 'materialize_native_sqlite3');
  assert.equal(second.status, 0, `second run failed: ${second.stdout}${second.stderr}`);
  assert.match(second.stdout, /already a real directory/);
  assert.ok(fs.existsSync(path.join(sqlitePath, 'OSI_SENTINEL')),
    'a second run must not re-copy over a directory that is already materialised');
});

test('materialize_native_sqlite3 keeps the symlink when the staged copy cannot load', () => {
  const gw = makeGateway('firmware-symlink');
  const sqlitePath = path.join(gw.proj, 'node_modules', 'sqlite3');

  // The gateway equivalent: /srv/node-red/node_modules has no `bindings` yet
  // (npm has never run there), so a copy placed under it would not resolve,
  // while the symlink still resolves through the firmware tree. Swapping in
  // that copy would leave the gateway without a loadable sqlite3.
  fs.rmSync(path.join(gw.proj, 'node_modules', 'fixture-peer'), { recursive: true, force: true });

  const r = shellHarness(gw, 'materialize_native_sqlite3');
  assert.equal(r.status, 0, 'a copy that does not load must not fail the deploy outright');
  assert.ok(isSymlink(sqlitePath), 'the firmware symlink must still be there');
  assert.equal(requireSqlite3Through(gw), 0, 'the gateway must still have a loadable sqlite3');
  assert.match(r.stderr, /staged copy/);
  const strays = fs.readdirSync(path.join(gw.proj, 'node_modules')).filter((n) => n.startsWith('.osi-sqlite3'));
  assert.deepEqual(strays, [], `materialise left staging directories behind: ${strays.join(', ')}`);
});

// Loads the module through whatever /srv/node-red/node_modules/sqlite3 is,
// resolving peers the way node would for that path (the firmware tree for a
// symlink). Used where the project's own node_modules is deliberately
// incomplete.
function requireSqlite3Through(gw) {
  const target = path.join(gw.proj, 'node_modules', 'sqlite3');
  return spawnSync(process.execPath, ['-e', [
    "const sqlite3 = require(process.argv[1]);",
    "const db = new sqlite3.Database(':memory:', function (err) {",
    '  if (err) { console.error(String(err)); process.exit(1); }',
    '  db.close(function () { process.exit(0); });',
    '});',
  ].join('\n'), target], { cwd: gw.proj, encoding: 'utf8' }).status;
}

test('materialize_native_sqlite3 clears a dangling symlink and restores from the firmware module', () => {
  const gw = makeGateway('dangling-symlink');
  const sqlitePath = path.join(gw.proj, 'node_modules', 'sqlite3');

  const r = shellHarness(gw, 'materialize_native_sqlite3');
  assert.equal(r.status, 0, `materialise should not fail on a dangling symlink: ${r.stderr}`);
  assert.match(r.stderr, /dangling symlink/);
  assert.equal(isSymlink(sqlitePath), false, 'the dangling symlink should be gone');
  assert.ok(hasBinding(sqlitePath), 'the firmware module should have been restored in its place');
  assert.equal(requireSqlite3(gw.proj).status, 0, "require('sqlite3') should work again");
});

test('materialize_native_sqlite3 clears a dangling symlink and leaves the install to npm when the firmware module is gone', () => {
  const gw = makeGateway('dangling-symlink');
  const sqlitePath = path.join(gw.proj, 'node_modules', 'sqlite3');

  const r = shellHarness(gw, 'materialize_native_sqlite3', { firmware: false });
  assert.equal(r.status, 0, `materialise should not fail on a dangling symlink: ${r.stderr}`);
  assert.equal(fs.existsSync(sqlitePath) || isSymlink(sqlitePath), false,
    'the dangling symlink should be gone so npm can install sqlite3 itself');
  assert.match(r.stderr, /dangling symlink/);
  assert.match(r.stdout, /SKIP/);
});

test('materialize_native_sqlite3 does nothing when neither the module nor the firmware is there', () => {
  const gw = makeGateway('absent');
  const r = shellHarness(gw, 'materialize_native_sqlite3', { firmware: false });
  assert.equal(r.status, 0, `materialise should not fail on a fresh tree: ${r.stderr}`);
  assert.match(r.stdout, /SKIP/);
});

// --- self-healing after a deploy killed mid-swap ----------------------------
//
// rename(2) cannot replace a symlink with a directory, so materialise has to
// unlink before it moves. A deploy killed in that instant (SSH drop, power
// loss, OOM) leaves nothing at node_modules/sqlite3 -- Node-RED's sqlite nodes
// then fail on the next boot, and the next deploy is the repair path.

test('materialize_native_sqlite3 restores the module when a killed deploy left the path empty', () => {
  const gw = makeGateway('absent');
  const sqlitePath = path.join(gw.proj, 'node_modules', 'sqlite3');

  const r = shellHarness(gw, 'materialize_native_sqlite3');
  assert.equal(r.status, 0, `materialise should restore from the firmware: ${r.stdout}${r.stderr}`);
  assert.equal(isSymlink(sqlitePath), false, 'the restored module must be a real directory');
  assert.ok(hasBinding(sqlitePath), 'the restored module must carry the firmware binary');
  assert.equal(requireSqlite3(gw.proj).status, 0, "require('sqlite3') should work again");

  const install = npmInstallLikeDeploy(gw.proj);
  assert.equal(install.status, 0, `npm install failed after restoring: ${install.stderr}`);
  assert.ok(hasBinding(sqlitePath), 'npm must leave the restored native module alone');
  assert.equal(shellHarness(gw, 'verify_native_sqlite3_after_npm').status, 0);
});

test('materialize_native_sqlite3 leaves an empty path empty when the staged copy cannot load', () => {
  const gw = makeGateway('absent');
  const sqlitePath = path.join(gw.proj, 'node_modules', 'sqlite3');
  fs.rmSync(path.join(gw.proj, 'node_modules', 'fixture-peer'), { recursive: true, force: true });

  const r = shellHarness(gw, 'materialize_native_sqlite3');
  assert.equal(r.status, 0, 'a copy that does not load must not fail the deploy outright');
  assert.equal(fs.existsSync(sqlitePath), false,
    'nothing that cannot load may be swapped in; npm decides instead');
  assert.match(r.stderr, /staged copy/);
  assert.deepEqual(stagingLeftovers(gw), []);
});

test('materialize_native_sqlite3 clears a staging directory left by a deploy killed mid-swap', () => {
  const gw = makeGateway('absent');
  const sqlitePath = path.join(gw.proj, 'node_modules', 'sqlite3');

  // exactly what a kill between the unlink and the move leaves behind: a full
  // staged copy under the staging name, and nothing at node_modules/sqlite3.
  const stale = path.join(gw.proj, 'node_modules', '.osi-sqlite3-stage.kIlLeD');
  copyDir(gw.fwSqlite, stale);
  assert.ok(hasBinding(stale));

  const r = shellHarness(gw, 'materialize_native_sqlite3');
  assert.equal(r.status, 0, `materialise should clean up and restore: ${r.stdout}${r.stderr}`);
  assert.equal(fs.existsSync(stale), false, 'the leftover staging directory must be removed');
  assert.match(r.stderr, /interrupted deploy/);
  assert.ok(hasBinding(sqlitePath), 'and the module must be restored');
  assert.deepEqual(stagingLeftovers(gw), []);
});

test('materialize_native_sqlite3 only removes its own staging directories', () => {
  const gw = makeGateway('firmware-symlink');
  const modules = path.join(gw.proj, 'node_modules');
  // a dot-entry that shares the prefix but is not a staging directory, plus
  // everything npm already put there
  fs.mkdirSync(path.join(modules, '.osi-sqlite3-keepme'), { recursive: true });
  const before = fs.readdirSync(modules).sort();

  assert.equal(shellHarness(gw, 'materialize_native_sqlite3').status, 0);

  assert.deepEqual(fs.readdirSync(modules).sort(), before,
    'materialise must not remove anything but its own staging directories');
});

function stagingLeftovers(gw) {
  return fs.readdirSync(path.join(gw.proj, 'node_modules')).filter((n) => n.startsWith('.osi-sqlite3-stage.'));
}

test('materialize_native_sqlite3 does not touch a real directory that has no binary', () => {
  // npm will leave it alone too (the version matches the lock), so the
  // post-npm verification is what stops the deploy here.
  const gw = makeGateway('real-without-binary');
  const sqlitePath = path.join(gw.proj, 'node_modules', 'sqlite3');

  const r = shellHarness(gw, 'materialize_native_sqlite3');
  assert.equal(r.status, 0, `materialise should be a no-op here: ${r.stderr}`);
  assert.equal(hasBinding(sqlitePath), false, 'materialise must not invent a binary');

  const verify = shellHarness(gw, 'verify_native_sqlite3_after_npm');
  assert.notEqual(verify.status, 0, 'the post-npm verification must refuse a module that cannot load');
  assert.match(verify.stderr, /require\('sqlite3'\) failed/);
});

test('verify_native_sqlite3_after_npm passes on a working module', () => {
  const gw = makeGateway('real-with-binary');
  const r = shellHarness(gw, 'verify_native_sqlite3_after_npm');
  assert.equal(r.status, 0, `verification should pass: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /opens :memory:/);
});

// --- preflight --------------------------------------------------------------

function writeLockFixture(gw, version) {
  const p = path.join(gw.root, `lock-${version}.json`);
  fs.writeFileSync(p, JSON.stringify({
    lockfileVersion: 3,
    packages: { 'node_modules/sqlite3': { version, resolved: `https://registry.npmjs.org/sqlite3/-/sqlite3-${version}.tgz` } },
  }, null, 2));
  return p;
}

function muslPresent(gw) {
  const dir = path.join(gw.root, 'fake-libc');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ld-musl-armhf.so.1'), '');
  return path.join(dir, 'ld-musl-*.so.1');
}

test('run_native_sqlite3_preflight refuses a version mismatch that cannot be built on armv7l + musl', () => {
  const gw = makeGateway('firmware-symlink');
  const r = shellHarness(gw, 'run_native_sqlite3_preflight', {
    lockFixture: writeLockFixture(gw, '5.1.8'),
    arch: 'armv7l',
    muslGlob: muslPresent(gw),
    toolchain: false,
  });
  assert.notEqual(r.status, 0, 'the preflight must stop the deploy before any side effect');
  assert.match(r.stderr, /5\.1\.8/, 'the message must name the locked version');
  assert.match(r.stderr, /5\.1\.7/, 'the message must name the installed version');
  assert.match(r.stderr, /musl/);
});

test('run_native_sqlite3_preflight passes when the installed version matches the lockfile', () => {
  const gw = makeGateway('firmware-symlink');
  const r = shellHarness(gw, 'run_native_sqlite3_preflight', {
    lockFixture: writeLockFixture(gw, LOCKED_VERSION),
    arch: 'armv7l',
    muslGlob: muslPresent(gw),
    toolchain: false,
  });
  assert.equal(r.status, 0, `preflight should pass: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /matches the shipped lockfile/);
});

test('run_native_sqlite3_preflight only warns about a version mismatch on aarch64', () => {
  const gw = makeGateway('firmware-symlink');
  const r = shellHarness(gw, 'run_native_sqlite3_preflight', {
    lockFixture: writeLockFixture(gw, '5.1.8'),
    arch: 'aarch64',
    muslGlob: muslPresent(gw),
    toolchain: false,
  });
  assert.equal(r.status, 0, 'a prebuilt exists for arm64 + musl, so this must not be fatal');
  assert.match(r.stdout, /WARN/);
});

test('run_native_sqlite3_preflight only warns when a build toolchain is present', () => {
  const gw = makeGateway('firmware-symlink');
  const r = shellHarness(gw, 'run_native_sqlite3_preflight', {
    lockFixture: writeLockFixture(gw, '5.1.8'),
    arch: 'armv7l',
    muslGlob: muslPresent(gw),
    toolchain: true,
  });
  assert.equal(r.status, 0, 'a gateway that can build from source must not be refused');
  assert.match(r.stdout, /WARN/);
});

test('run_native_sqlite3_preflight skips a gateway with no sqlite3 module and no firmware module', () => {
  const gw = makeGateway('absent');
  const r = shellHarness(gw, 'run_native_sqlite3_preflight', {
    lockFixture: writeLockFixture(gw, '5.1.8'),
    arch: 'armv7l',
    muslGlob: muslPresent(gw),
    toolchain: false,
    firmware: false,
  });
  assert.equal(r.status, 0, 'a fresh gateway has nothing to compare');
  assert.match(r.stdout, /SKIP/);
});

test('run_native_sqlite3_preflight compares the firmware version when the path is empty', () => {
  // The killed-mid-swap state: the version that will land at
  // node_modules/sqlite3 is the firmware module's, so that is the one that
  // has to match the lockfile -- and on armv7l + musl a mismatch is still
  // unwinnable, so it must be refused before any side effect.
  const gw = makeGateway('absent');
  const bad = shellHarness(gw, 'run_native_sqlite3_preflight', {
    lockFixture: writeLockFixture(gw, '5.1.8'),
    arch: 'armv7l',
    muslGlob: muslPresent(gw),
    toolchain: false,
  });
  assert.notEqual(bad.status, 0, 'the preflight must refuse the mismatch it can already see');
  assert.match(bad.stderr, /5\.1\.8/);
  assert.match(bad.stderr, /5\.1\.7/);
  assert.match(bad.stderr, /firmware/);

  const good = shellHarness(gw, 'run_native_sqlite3_preflight', {
    lockFixture: writeLockFixture(gw, LOCKED_VERSION),
    arch: 'armv7l',
    muslGlob: muslPresent(gw),
    toolchain: false,
  });
  assert.equal(good.status, 0, `matching versions must pass: ${good.stdout}${good.stderr}`);
  assert.match(good.stdout, /matches the shipped lockfile/);
});

// --- wiring -----------------------------------------------------------------

test('deploy.sh wires the three native-sqlite3 steps in the right order', () => {
  const preflight = DEPLOY.indexOf('\nrun_native_sqlite3_preflight || exit 1');
  const materialize = DEPLOY.indexOf('\nmaterialize_native_sqlite3 || exit 1');
  const npmStep = DEPLOY.indexOf('npm install --omit=dev --no-fund --no-audit');
  const verify = DEPLOY.indexOf('\nverify_native_sqlite3_after_npm || exit 1');
  const migration = DEPLOY.indexOf('\nrun_schema_migration || exit 1');
  const bootstrap = DEPLOY.indexOf('Provisioning STREGA Gen2 device profile');
  // the CALL, not the definition: it is the first uci write of the deploy
  const journalUci = DEPLOY.indexOf('\nensure_journal_media_defaults\n');
  const firstWrite = DEPLOY.indexOf('\nfetch_required "Node-RED settings.js"');

  assert.notEqual(preflight, -1, 'deploy.sh never calls run_native_sqlite3_preflight');
  assert.notEqual(materialize, -1, 'deploy.sh never calls materialize_native_sqlite3');
  assert.notEqual(verify, -1, 'deploy.sh never calls verify_native_sqlite3_after_npm');

  assert.ok(journalUci > 0 && preflight < journalUci, 'the preflight must run before the first uci write');
  assert.ok(firstWrite > 0 && preflight < firstWrite,
    'the preflight must run before deploy.sh writes its first file to the gateway');
  assert.ok(preflight < bootstrap, 'the preflight must run before the ChirpStack bootstrap');
  assert.ok(materialize < npmStep, 'materialise must run before npm install');
  assert.ok(npmStep < verify, 'the verification must run after npm install');
  assert.ok(verify < migration, 'the verification must run before the schema migration');

  // The npm failure path that exists today must stay exactly as loud.
  assert.match(DEPLOY, /ERROR: npm install failed/);
  assert.ok(!/npm install .*--ignore-scripts/.test(DEPLOY),
    'deploy.sh must not install with --ignore-scripts');
});

test('the firmware seed scripts hand npm a real sqlite3 directory, identically on both profiles', () => {
  const profiles = ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709'];
  const seeds = profiles.map((p) => fs.readFileSync(
    path.join(REPO, 'conf', p, 'files/etc/uci-defaults/98_osi_node_red_seed'), 'utf8'));

  assert.equal(seeds[0], seeds[1], 'the two profiles must ship the same seed script');
  const seed = seeds[0];
  assert.match(seed, /cp -a "\$SQLITE_SRC" "\$DST\/node_modules\/sqlite3"/,
    'the seed must copy the firmware sqlite3, not link it: a Link at that path is what npm retires');
  // The symlink survives as the fallback when the copy cannot be made, and
  // deploy.sh has to keep handling it either way because field images ship it.
  assert.match(seed, /ln -s "\$SQLITE_SRC" "\$DST\/node_modules\/sqlite3"/);
  assert.match(DEPLOY, /materialize_native_sqlite3\(\) \{/);
});

test('materialize_native_sqlite3 does not abort a gateway that has no node_modules at all', () => {
  // A brand-new gateway: deploy.sh creates /srv/node-red but not
  // node_modules, so mktemp -d would fail inside a missing directory. Nothing
  // can be verified there either (no peer packages yet), so the outcome is
  // the documented "leave it to npm" fallback -- but it must never be a hard
  // failure that stops the deploy.
  const gw = makeGateway('absent');
  fs.rmSync(path.join(gw.proj, 'node_modules'), { recursive: true, force: true });

  const r = shellHarness(gw, 'materialize_native_sqlite3');
  assert.equal(r.status, 0, `materialise must not fail on a gateway with no node_modules: ${r.stdout}${r.stderr}`);
  assert.equal(fs.existsSync(path.join(gw.proj, 'node_modules', 'sqlite3')), false,
    'nothing unverified may be swapped in');
  assert.deepEqual(stagingLeftovers(gw), [], 'and no staging directory may be left behind');
});
