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
    'NS_LOCKED=5.1.7',
    `NATIVE_ARCH=${JSON.stringify(opts.arch || 'armv7l')}`,
    `MUSL_LOADER_GLOB=${JSON.stringify(opts.muslGlob || path.join(gw.root, 'fake-libc', 'ld-musl-*.so.1'))}`,
  ];
  if (opts.fetchFails) {
    // A 404 through the tunnel: curl -f writes nothing and exits 22.
    preamble.push('fetch() { mkdir -p "$(dirname "$2")"; return 22; }');
  } else if (opts.lockFixture) {
    // deploy.sh curls the shipped lockfile through the SSH tunnel; here the
    // preflight gets a fixture straight off disk.
    preamble.push(`fetch() { mkdir -p "$(dirname "$2")"; cp ${JSON.stringify(opts.lockFixture)} "$2"; }`);
  }
  const script = [
    ...preamble,
    extractFunction('native_sqlite3_dir_loads'),
    extractFunction('native_build_toolchain_present'),
    extractFunction('native_sqlite3_reinstall_impossible'),
    ...r2OptionalDeployHelpers(),
    extractFunction('run_native_sqlite3_preflight'),
    extractFunction('materialize_native_sqlite3'),
    extractFunction('verify_native_sqlite3_after_npm'),
    opts.toolchain === false
      ? 'native_build_toolchain_present() { return 1; }'
      : (opts.toolchain === true ? 'native_build_toolchain_present() { return 0; }' : ''),
    ...(opts.shellHooks || []),
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

// deploy.sh calls the preflight as "run_native_sqlite3_preflight || exit 1",
// where set -e does not apply inside it; the condition below is the same.
const PREFLIGHT_IN_CONDITION = 'if run_native_sqlite3_preflight; then echo "PREFLIGHT-RC=0"; else echo "PREFLIGHT-RC=$?"; fi';

test('run_native_sqlite3_preflight stops when the shipped lockfile cannot be fetched', () => {
  const gw = makeGateway('firmware-symlink');
  const r = shellHarness(gw, PREFLIGHT_IN_CONDITION, { fetchFails: true, arch: 'armv7l', muslGlob: muslPresent(gw), toolchain: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT-RC=[1-9]/, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /ERROR: could not fetch the shipped package-lock\.json/);
  assert.doesNotMatch(r.stdout, /skipping the preflight/);
});

test('run_native_sqlite3_preflight stops on a lockfile that is not valid JSON', () => {
  const gw = makeGateway('firmware-symlink');
  const lock = path.join(gw.root, 'lock-truncated.json');
  fs.writeFileSync(lock, '{"lockfileVersion": 3, "packages": {"node_modules/sqlite3": {"vers');
  const r = shellHarness(gw, PREFLIGHT_IN_CONDITION, { lockFixture: lock, arch: 'armv7l', muslGlob: muslPresent(gw), toolchain: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT-RC=[1-9]/, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /ERROR: the shipped package-lock\.json is not valid JSON/);
  assert.doesNotMatch(r.stdout, /skipping the preflight/);
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

// Native sqlite3 recovery cases. The deploy cases run the actual deploy.sh
// helper text; the seed cases run the exact BEGIN/END block of the mirrored
// 98_osi_node_red_seed script, without its broad copy, helper loop or chown.
function r2Quote(s) { return "'" + s.replaceAll("'", "'\\''") + "'"; }
function r2OptionalDeployHelpers() {
  return ['native_sqlite3_report_paths', 'native_sqlite3_pkg_version', 'native_sqlite3_exact_file',
    'native_sqlite3_present', 'native_sqlite3_id', 'native_sqlite3_new_exact_file',
    'native_sqlite3_restore_original', 'native_sqlite3_scan_backup',
    'native_sqlite3_owned_final', 'native_sqlite3_recovery_lock',
    'native_sqlite3_recover_early', 'native_sqlite3_rollback_failed_final',
    'native_sqlite3_unrepaired', 'native_sqlite3_owner_prefix',
    'native_sqlite3_clear_metadata_backup']
    .filter(n => new RegExp('^' + n + '\\(\\) \\{', 'm').test(DEPLOY))
    .map(extractFunction);
}
function r2SeedHarness(gw, opts = {}) {
  const rel = p => path.join(REPO, 'conf', p,
    'files/etc/uci-defaults/98_osi_node_red_seed');
  const a = fs.readFileSync(rel('full_raspberrypi_bcm27xx_bcm2712'), 'utf8');
  const b = fs.readFileSync(rel('full_raspberrypi_bcm27xx_bcm2709'), 'utf8');
  assert.equal(a, b, 'seed profile bytes differ');
  const sourceLine = 'SQLITE_SRC=/usr/lib/node/node-red/node_modules/node-red-node-sqlite/node_modules/sqlite3';
  const oldRemove = 'rm -rf "$DST/node_modules/sqlite3" "$DST/node_modules/node-red-node-sqlite"';
  const oldSource = [sourceLine, 'if [ -d "$SQLITE_SRC" ]; then',
    '    if ! cp -a "$SQLITE_SRC" "$DST/node_modules/sqlite3"; then',
    '        rm -rf "$DST/node_modules/sqlite3"',
    '        ln -s "$SQLITE_SRC" "$DST/node_modules/sqlite3"',
    '    fi', 'fi'].join('\n');
  let body;
  const begin = '# BEGIN native sqlite3 seed';
  const end = '# END native sqlite3 seed';
  if (a.includes(begin) || a.includes(end)) {
    assert.equal(a.split(begin).length, 2, 'candidate seed BEGIN count');
    assert.equal(a.split(end).length, 2, 'candidate seed END count');
    const segment = a.slice(a.indexOf(begin) + begin.length, a.indexOf(end)).trim();
    assert.match(segment, /seed_native_sqlite3\(\) \{/);
    assert.match(segment, /\nseed_native_sqlite3 \|\| exit 1$/);
    body = segment.replace(/\nseed_native_sqlite3 \|\| exit 1$/, '');
  } else {
    assert.ok(a.includes('\n' + oldRemove + '\n'), 'BASE deletion bytes changed');
    assert.ok(a.includes('\n' + oldSource + '\n'), 'BASE source block bytes changed');
    body = 'seed_native_sqlite3() {\n' + oldRemove + '\n' + oldSource + '\n}';
  }
  const src = path.join(gw.root, 'share', 'node-red');
  const sqliteSrc = opts.firmware === false
    ? path.join(gw.root, 'firmware-that-was-removed', 'sqlite3') : gw.fwSqlite;
  fs.mkdirSync(src, { recursive: true });
  const lock = opts.sourceLock || writeLockFixture(gw, LOCKED_VERSION);
  fs.copyFileSync(lock, path.join(src, 'package-lock.json'));
  assert.equal(body.split(sourceLine).length, 2, 'firmware assignment count');
  body = body.replace(sourceLine, 'SQLITE_SRC=' + r2Quote(sqliteSrc));
  const script = ['set -eu', 'SRC=' + r2Quote(src),
    'DST=' + r2Quote(gw.proj), body, ...(opts.shellHooks || []),
    'if seed_native_sqlite3; then echo SEED_RC=0; else echo SEED_RC=$?; fi',
    'echo AFTER_SEED'].join('\n');
  return spawnSync('sh', ['-c', script], { encoding: 'utf8' });
}
function r2DeployCall(gw, opts = {}) {
  // deploy.sh runs `materialize_native_sqlite3 || exit 1`, so the post-npm
  // verifier never follows a refused materialisation. `verify: false` stops
  // at the same point for a case that must refuse; every other case verifies.
  const verify = opts.verify === false ? []
    : ['if verify_native_sqlite3_after_npm; then echo VERIFY_RC=0; else echo VERIFY_RC=$?; fi'];
  const body = [
    'if run_native_sqlite3_preflight; then echo PREFLIGHT_RC=0; else echo PREFLIGHT_RC=$?; fi',
    'if materialize_native_sqlite3; then echo MATERIALIZE_RC=0; else echo MATERIALIZE_RC=$?; fi',
    ...verify,
    'echo AFTER_MATERIALIZE',
  ].join('\n');
  return shellHarness(gw, body, {
    lockFixture: opts.lockFixture || writeLockFixture(gw, LOCKED_VERSION),
    arch: opts.arch || 'armv7l', muslGlob: opts.muslGlob || muslPresent(gw),
    toolchain: opts.toolchain === undefined ? false : opts.toolchain,
    shellHooks: opts.shellHooks || [], firmware: opts.firmware,
  });
}
function r2Names(gw, prefix) {
  return fs.readdirSync(path.join(gw.proj, 'node_modules'))
    .filter(n => n.startsWith(prefix)).sort();
}
function r2OldBytes(gw) {
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  fs.writeFileSync(path.join(d, 'original.txt'), 'old bytes\n');
  return { d, original: fs.readFileSync(path.join(d, 'original.txt')) };
}

test('R2 RED broken matching-version real directory repairs before npm on impossible target', () => {
  const gw = makeGateway('real-without-binary');
  const { d } = r2OldBytes(gw);
  const r = r2DeployCall(gw);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT_RC=0/);
  assert.match(r.stdout, /MATERIALIZE_RC=0/);
  assert.match(r.stdout, /VERIFY_RC=0/); // P predicts VERIFY_RC=1
  assert.match(r.stdout, /AFTER_MATERIALIZE/);
  assert.equal(requireSqlite3(gw.proj).status, 0);
  assert.equal(fs.existsSync(path.join(d, 'original.txt')), false);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-stage.'), []);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
});
test('R2 RED absent seed source preserves both installed entries', () => {
  const gw = makeGateway('real-with-binary');
  const { d, original } = r2OldBytes(gw);
  const peer = path.join(gw.proj, 'node_modules', 'node-red-node-sqlite');
  fs.mkdirSync(peer, { recursive: true });
  fs.writeFileSync(path.join(peer, 'peer.txt'), 'peer bytes\n');
  const r = r2SeedHarness(gw, { firmware: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/); // P predicts SEED_RC=0
  assert.match(r.stdout, /AFTER_SEED/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n');
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-'), []);
});
test('R2 broken matching-version real directory refuses a failed repair even when reinstall is viable', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const peer = path.join(gw.proj, 'node_modules', 'fixture-peer');
  fs.rmSync(peer, { recursive: true, force: true }); // source peer remains
  const r = r2DeployCall(gw, { arch: 'aarch64' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT_RC=0/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.match(r.stdout, /AFTER_MATERIALIZE/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
});
test('R2 deploy copy fault matches source-dot and stage-slash arguments', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  // `${n-}` keeps the hook safe under `set -u` for the harness's own
  // two-argument fetch copy; every call that does not match is forwarded.
  const hook = 'cp() { case "${1-}:${2-}:${3-}" in "-a:$NATIVE_SQLITE3_FIRMWARE_DIR/.:"*/.osi-sqlite3-stage.*/)' +
    ' echo DEPLOY_CP_HOOK >&2; return 23 ;; esac; command cp "$@"; }';
  const r = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /DEPLOY_CP_HOOK/);
  assert.match(r.stderr, /ERROR: could not copy sqlite3 into stage/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-stage.'), []);
});
test('R2 deploy ordinary old-path mv failure before rename retains old path', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const hook = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/sqlite3:"*/.osi-sqlite3-rollback.*/original)' +
    ' echo MV_BEFORE >&2; return 27 ;; esac; command mv "$@"; }';
  const r = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /MV_BEFORE/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.equal(r2Names(gw, '.osi-sqlite3-rollback.').length, 1);
});
test('R2 deploy bounded interruption after real old-path rename restores before ordinary write', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const hook = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/sqlite3:"*/.osi-sqlite3-rollback.*/original)' +
    ' command mv "$@" || return $?; echo INTERRUPT_AFTER_OLD >&2; exit 26 ;; esac; command mv "$@"; }';
  const first = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(first.status, 26, first.stderr);
  assert.match(first.stderr, /INTERRUPT_AFTER_OLD/);
  assert.doesNotMatch(first.stdout, /AFTER_MATERIALIZE/);
  assert.equal(fs.existsSync(d), false);
  assert.equal(r2Names(gw, '.osi-sqlite3-rollback.').length, 1);
  const second = shellHarness(gw, [
    'fetch() { return 22; }', // lock unavailable; restoration must precede it
    'if run_native_sqlite3_preflight; then echo PREFLIGHT_RC=0; echo ORDINARY_WRITE; else echo PREFLIGHT_RC=$?; fi',
    'test -f "$NODE_RED_ROOT/node_modules/sqlite3/original.txt" || exit 29',
    'echo AFTER_PREFLIGHT',
  ].join('\n'), { arch: 'armv7l', muslGlob: muslPresent(gw), toolchain: false });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.match(second.stdout, /AFTER_PREFLIGHT/);
  assert.doesNotMatch(second.stdout, /ORDINARY_WRITE/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
});
test('R2 deploy status failure after old rename is distinct from interruption', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const hook = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/sqlite3:"*/.osi-sqlite3-rollback.*/original)' +
    ' command mv "$@" || return $?; echo MV_AFTER_STATUS >&2; return 28 ;; esac; command mv "$@"; }';
  const r = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /MV_AFTER_STATUS/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.equal(fs.existsSync(d), false);
  const b = path.join(gw.proj, 'node_modules', r2Names(gw, '.osi-sqlite3-rollback.')[0]);
  assert.deepEqual(fs.readFileSync(path.join(b, 'original', 'original.txt')), original);
});
test('R2 seed copy fault matches source and candidate arguments; verified link is fallback', () => {
  const gw = makeGateway('real-without-binary');
  const peer = path.join(gw.proj, 'node_modules', 'node-red-node-sqlite');
  fs.mkdirSync(peer, { recursive: true });
  fs.writeFileSync(path.join(peer, 'peer.txt'), 'peer bytes\n');
  const hook = 'cp() { case "$1:$2:$3" in "-a:$SQLITE_SRC:"*/.osi-sqlite3-seed-stage.*/candidate)' +
    ' echo SEED_CP_HOOK >&2; return 23 ;; esac; command cp "$@"; }';
  const r = r2SeedHarness(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /SEED_CP_HOOK/);
  assert.match(r.stdout, /SEED_RC=0/);
  assert.equal(fs.lstatSync(path.join(gw.proj, 'node_modules', 'sqlite3')).isSymbolicLink(), true);
  assert.equal(requireSqlite3Through(gw), 0);
  assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n');
});
test('R2 seed same-target replacement symlink cannot borrow promotion identity', () => {
  const gw = makeGateway('real-without-binary');
  r2OldBytes(gw);
  fs.rmSync(path.join(gw.proj, 'node_modules', 'fixture-peer'), { recursive: true, force: true });
  const hook = 'mv() { case "$1:$2" in */.osi-sqlite3-seed-stage.*/link:"$DST/node_modules/sqlite3")' +
    ' command mv "$@" || return $?; echo INTERRUPT_AFTER_LINK >&2; exit 26 ;; esac; command mv "$@"; }';
  const first = r2SeedHarness(gw, { shellHooks: [hook] });
  assert.equal(first.status, 26, first.stderr);
  assert.match(first.stderr, /INTERRUPT_AFTER_LINK/);
  assert.doesNotMatch(first.stdout, /AFTER_SEED/);
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  assert.equal(fs.lstatSync(d).isSymbolicLink(), true);
  fs.unlinkSync(d);
  fs.symlinkSync(gw.fwSqlite, d); // same target text, different symlink inode
  const second = r2SeedHarness(gw);
  assert.match(second.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.equal(fs.lstatSync(d).isSymbolicLink(), true);
  assert.equal(r2Names(gw, '.osi-sqlite3-seed-rollback.').length, 1);
});
test('R2 seed orphan real marker validates pin and load before removal', () => {
  const gw = makeGateway('real-with-binary');
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  const missingB = path.join(gw.proj, 'node_modules', '.osi-sqlite3-seed-rollback.missing');
  fs.writeFileSync(path.join(d, '.osi-sqlite3-candidate-owner'), missingB + '\n');
  const r = r2SeedHarness(gw);
  assert.match(r.stdout, /SEED_RC=0/);
  assert.equal(fs.existsSync(path.join(d, '.osi-sqlite3-candidate-owner')), false);
});
test('R2 unknown destination file, FIFO and rollback marker types fail closed', () => {
  for (const kind of ['file', 'fifo']) {
    const gw = makeGateway('absent');
    const d = path.join(gw.proj, 'node_modules', 'sqlite3');
    if (kind === 'file') fs.writeFileSync(d, 'unrelated\n');
    else assert.equal(spawnSync('mkfifo', [d]).status, 0);
    const before = fs.lstatSync(d).mode;
    // require('sqlite3') opens a FIFO at the final path and blocks with no
    // writer, so the FIFO case stops after the refused materialisation.
    const r = r2DeployCall(gw, { verify: kind !== 'fifo' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
    assert.match(r.stderr, /unexpected sqlite3 destination type before deploy writes/);
    assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
    assert.match(r.stderr, /ERROR: unexpected sqlite3 destination type: /);
    if (kind === 'fifo') assert.doesNotMatch(r.stdout, /VERIFY_RC=/);
    assert.match(r.stdout, /AFTER_MATERIALIZE/);
    assert.equal(fs.lstatSync(d).mode, before);
  }
  const gw = makeGateway('real-without-binary');
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  const b = path.join(gw.proj, 'node_modules', '.osi-sqlite3-rollback.unknown');
  fs.mkdirSync(b);
  fs.symlinkSync(d, path.join(b, '.owner'));
  const before = fs.readdirSync(path.join(gw.proj, 'node_modules')).sort();
  const r = r2DeployCall(gw);
  assert.match(r.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readdirSync(path.join(gw.proj, 'node_modules')).sort(), before);
});
test('R2 seed rejects file, FIFO and malformed candidate identity without deleting entries', () => {
  for (const kind of ['file', 'fifo']) {
    const gw = makeGateway('real-with-binary');
    const d = path.join(gw.proj, 'node_modules', 'sqlite3');
    fs.rmSync(d, { recursive: true, force: true });
    if (kind === 'file') fs.writeFileSync(d, 'unrelated\n');
    else assert.equal(spawnSync('mkfifo', [d]).status, 0);
    const before = fs.lstatSync(d).mode;
    const r = r2SeedHarness(gw);
    assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
    assert.equal(fs.lstatSync(d).mode, before);
  }
  const gw = makeGateway('real-with-binary');
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  const b = path.join(gw.proj, 'node_modules', '.osi-sqlite3-seed-rollback.bad-id');
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, '.owner'), 'osi-sqlite3-seed-v2\n');
  fs.writeFileSync(path.join(b, '.candidate-id'), 'unverified identity\n');
  const before = fs.readdirSync(path.dirname(d)).sort();
  const r = r2SeedHarness(gw);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readdirSync(path.dirname(d)).sort(), before);
  assert.equal(fs.lstatSync(d).isDirectory(), true);
});
test('R2 wrong firmware version and missing pin retain broken real bytes', () => {
  for (const fault of ['wrong-source-version', 'missing-pin']) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    let lock = writeLockFixture(gw, LOCKED_VERSION);
    if (fault === 'wrong-source-version') {
      const pkg = path.join(gw.fwSqlite, 'package.json');
      const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      parsed.version = '5.1.8';
      fs.writeFileSync(pkg, JSON.stringify(parsed));
    } else {
      lock = path.join(gw.root, 'missing-pin.json');
      fs.writeFileSync(lock, JSON.stringify({ lockfileVersion: 3, packages: {} }));
    }
    const r = r2DeployCall(gw, { lockFixture: lock });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
    if (fault === 'wrong-source-version')
      assert.match(r.stderr, /source pin missing or source version mismatch/);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
  }
});
test('R2 seed source mismatch and invalid image pins preserve both entries', () => {
  for (const fault of ['wrong-source-version', 'malformed-lock', 'missing-pin']) {
    const gw = makeGateway('real-with-binary');
    const { d, original } = r2OldBytes(gw);
    const peer = path.join(gw.proj, 'node_modules', 'node-red-node-sqlite');
    fs.mkdirSync(peer, { recursive: true });
    fs.writeFileSync(path.join(peer, 'peer.txt'), 'peer bytes\n');
    let lock = writeLockFixture(gw, LOCKED_VERSION);
    if (fault === 'wrong-source-version') {
      const pkg = path.join(gw.fwSqlite, 'package.json');
      const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      parsed.version = '5.1.8';
      fs.writeFileSync(pkg, JSON.stringify(parsed));
    } else if (fault === 'malformed-lock') {
      lock = path.join(gw.root, 'malformed-lock.json');
      fs.writeFileSync(lock, '{"packages":{"node_modules/sqlite3":');
    } else {
      lock = path.join(gw.root, 'missing-pin.json');
      fs.writeFileSync(lock, JSON.stringify({ lockfileVersion: 3, packages: {} }));
    }
    const r = r2SeedHarness(gw, { sourceLock: lock });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n');
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-'), []);
  }
});
test('R2 copied seed stage uses installed peers and falls back to firmware link', () => {
  const gw = makeGateway('real-without-binary');
  fs.rmSync(path.join(gw.proj, 'node_modules', 'fixture-peer'), { recursive: true, force: true });
  const r = r2SeedHarness(gw);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SEED_RC=0/);
  assert.match(r.stderr, /temporary and npm can retire/);
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  assert.equal(fs.lstatSync(d).isSymbolicLink(), true);
  assert.equal(requireSqlite3Through(gw), 0);
});
test('R2 failed seed fallback link retains the old real directory', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.rmSync(path.join(gw.proj, 'node_modules', 'fixture-peer'), { recursive: true, force: true });
  const hook = 'ln() { case "$1:$2:$3" in "-s:$SQLITE_SRC:"*/.osi-sqlite3-seed-stage.*/link)' +
    ' echo SEED_LN_HOOK >&2; return 25 ;; esac; command ln "$@"; }';
  const r = r2SeedHarness(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /SEED_LN_HOOK/);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-'), []);
});
test('R2 seed successful copied real directory repeats without swapping', () => {
  const gw = makeGateway('real-without-binary');
  const peer = path.join(gw.proj, 'node_modules', 'node-red-node-sqlite');
  fs.mkdirSync(peer, { recursive: true });
  fs.writeFileSync(path.join(peer, 'peer.txt'), 'peer bytes\n');
  const first = r2SeedHarness(gw);
  assert.match(first.stdout, /SEED_RC=0/);
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  assert.equal(fs.lstatSync(d).isDirectory(), true);
  assert.equal(requireSqlite3(gw.proj).status, 0);
  fs.writeFileSync(path.join(d, 'repeat.txt'), 'repeat bytes\n');
  const second = r2SeedHarness(gw);
  assert.match(second.stdout, /SEED_RC=0/);
  assert.equal(fs.readFileSync(path.join(d, 'repeat.txt'), 'utf8'), 'repeat bytes\n');
  assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n');
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-'), []);
});
test('R2 deploy final-path load fault restores old real directory', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected final-path failure");\n');
  const r = r2DeployCall(gw);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
});
test('R2 seed final-path load fault restores old real directory', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected seed final-path failure");\n');
  const r = r2SeedHarness(gw);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-rollback.'), []);
  // The emptied stage is retained with its owner line; the next run removes it.
  const stages = r2Names(gw, '.osi-sqlite3-seed-stage.');
  assert.equal(stages.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(gw.proj, 'node_modules', stages[0])), ['.owner']);
  const again = r2SeedHarness(gw);
  assert.match(again.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.ok(again.stderr.includes('removing seed stage left by an earlier attempt: ' +
    path.join(gw.proj, 'node_modules', stages[0])), again.stderr);
  assert.equal(r2Names(gw, '.osi-sqlite3-seed-stage.').length, 1);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-rollback.'), []);
});
test('R2 partial promoted-candidate removal retains backup and reports surviving paths', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected final-path failure");\n');
  const hook = 'rm() { case "$1:$2" in "-rf:$NODE_RED_ROOT/node_modules/sqlite3")' +
    ' command rm -f "$2/index.js"; echo PARTIAL_RM_HOOK >&2; return 30 ;; esac; command rm "$@"; }';
  const r = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /PARTIAL_RM_HOOK/);
  assert.match(r.stderr, /may be partial/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  const names = r2Names(gw, '.osi-sqlite3-rollback.');
  assert.equal(names.length, 1);
  const b = path.join(gw.proj, 'node_modules', names[0]);
  assert.deepEqual(fs.readFileSync(path.join(b, 'original', 'original.txt')), original);
  assert.equal(fs.existsSync(path.join(d, 'index.js')), false);
});
test('R2 deploy orphan real marker requires pin and load before cleanup', () => {
  const gw = makeGateway('real-with-binary');
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  const missingB = path.join(gw.proj, 'node_modules', '.osi-sqlite3-rollback.missing');
  fs.writeFileSync(path.join(d, '.osi-sqlite3-candidate-owner'), missingB + '\n');
  const r = r2DeployCall(gw);
  assert.match(r.stdout, /PREFLIGHT_RC=0/);
  assert.equal(fs.existsSync(path.join(d, '.osi-sqlite3-candidate-owner')), false);
});
test('R2 deploy stage allocation fault never touches old real directory', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  // deploy.sh discards mktemp's stderr, so the hook records its call in a
  // file the fixture owns, outside node_modules.
  const marker = path.join(gw.root, 'stage-alloc-hook.marker');
  assert.equal(fs.existsSync(marker), false);
  const hook = 'mktemp() { case "${1-}:${2-}" in "-d:"*/.osi-sqlite3-stage.*)' +
    ' printf "STAGE_ALLOC_HOOK\\n" >> ' + r2Quote(marker) + '; return 24 ;; esac; command mktemp "$@"; }';
  const r = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'STAGE_ALLOC_HOOK\n');
  assert.match(r.stderr, /ERROR: could not create sqlite3 stage/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-stage.'), []);
});
test('R2 multiple or unknown-child rollback entries retain destination', () => {
  for (const fault of ['multiple', 'unknown-child']) {
    const gw = makeGateway('real-with-binary');
    const d = path.join(gw.proj, 'node_modules', 'sqlite3');
    const mods = path.dirname(d);
    const b1 = path.join(mods, '.osi-sqlite3-rollback.first');
    fs.mkdirSync(b1);
    fs.writeFileSync(path.join(b1, '.owner'), 'osi-sqlite3-deploy-v2\n');
    if (fault === 'multiple') {
      const b2 = path.join(mods, '.osi-sqlite3-rollback.second');
      fs.mkdirSync(b2);
      fs.writeFileSync(path.join(b2, '.owner'), 'osi-sqlite3-deploy-v2\n');
    } else fs.writeFileSync(path.join(b1, 'unknown'), 'keep\n');
    const before = fs.readdirSync(mods).sort();
    const r = r2DeployCall(gw);
    assert.match(r.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
    assert.deepEqual(fs.readdirSync(mods).sort(), before);
    assert.equal(fs.lstatSync(d).isDirectory(), true);
  }
});
test('R2 no installed or firmware module remains an npm fallback only when reinstall is viable', () => {
  const gw = makeGateway('absent');
  const r = shellHarness(gw,
    'if run_native_sqlite3_preflight; then echo PREFLIGHT_RC=0; else echo PREFLIGHT_RC=$?; fi',
    { firmware: false, arch: 'aarch64', toolchain: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT_RC=0/);
  assert.match(r.stdout, /SKIP/);
});
test('R2 deploy bounded interruption after stage promotion validates final before ordinary write', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const hook = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/".osi-sqlite3-stage.*:"$NODE_RED_ROOT/node_modules/sqlite3")' +
    ' command mv "$@" || return $?; echo INTERRUPT_AFTER_FINAL >&2; exit 26 ;; esac; command mv "$@"; }';
  const first = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(first.status, 26, first.stderr);
  assert.match(first.stderr, /INTERRUPT_AFTER_FINAL/);
  assert.doesNotMatch(first.stdout, /AFTER_MATERIALIZE/);
  assert.equal(requireSqlite3(gw.proj).status, 0);
  const names = r2Names(gw, '.osi-sqlite3-rollback.');
  assert.equal(names.length, 1);
  const b = path.join(gw.proj, 'node_modules', names[0]);
  assert.deepEqual(fs.readFileSync(path.join(b, 'original', 'original.txt')), original);
  const second = shellHarness(gw, [
    'if run_native_sqlite3_preflight; then echo PREFLIGHT_RC=0; echo ORDINARY_WRITE; else echo PREFLIGHT_RC=$?; fi',
    'echo AFTER_PREFLIGHT',
  ].join('\n'), { lockFixture: writeLockFixture(gw, LOCKED_VERSION),
    arch: 'armv7l', muslGlob: muslPresent(gw), toolchain: false });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.doesNotMatch(second.stdout, /ORDINARY_WRITE/);
  assert.equal(requireSqlite3(gw.proj).status, 0);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
  assert.equal(fs.existsSync(path.join(d, '.osi-sqlite3-candidate-owner')), false);
});
test('R2 seed bounded interruption after old rename restores existing entry', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const hook = 'mv() { case "$1:$2" in "$DST/node_modules/sqlite3:"*/.osi-sqlite3-seed-rollback.*/original)' +
    ' command mv "$@" || return $?; echo SEED_INTERRUPT_AFTER_OLD >&2; exit 26 ;; esac; command mv "$@"; }';
  const first = r2SeedHarness(gw, { shellHooks: [hook] });
  assert.equal(first.status, 26, first.stderr);
  assert.match(first.stderr, /SEED_INTERRUPT_AFTER_OLD/);
  assert.doesNotMatch(first.stdout, /AFTER_SEED/);
  assert.equal(fs.existsSync(d), false);
  const second = r2SeedHarness(gw);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
});

test('R3 copied deploy marker symlink cannot overwrite its target or the old module', () => {
  for (const present of [true, false]) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const target = path.join(gw.root, present ? 'external-marker.txt' : 'dangling-marker.txt');
    if (present) fs.writeFileSync(target, 'external bytes\n');
    fs.symlinkSync(target, path.join(gw.fwSqlite, '.osi-sqlite3-candidate-owner'));
    const r = r2DeployCall(gw);
    assert.equal(r.status, 0, r.stderr);
    if (present) assert.equal(fs.readFileSync(target, 'utf8'), 'external bytes\n');
    else assert.equal(fs.existsSync(target), false);
    assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
    assert.match(r.stderr, /already contains an ownership marker/);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
    // The refused stage is retained; the next materialise removes it first.
    const stages = r2Names(gw, '.osi-sqlite3-stage.');
    assert.equal(stages.length, 1);
    const again = r2DeployCall(gw);
    assert.ok(again.stderr.includes('left behind by an interrupted deploy: ' +
      path.join(gw.proj, 'node_modules', stages[0])), again.stderr);
    assert.match(again.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
    assert.equal(r2Names(gw, '.osi-sqlite3-stage.').length, 1);
    if (present) assert.equal(fs.readFileSync(target, 'utf8'), 'external bytes\n');
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  }
});
test('R3 copied seed marker symlink cannot overwrite its target or the old module', () => {
  for (const present of [true, false]) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const target = path.join(gw.root, present ? 'external-seed-marker.txt' : 'dangling-seed-marker.txt');
    if (present) fs.writeFileSync(target, 'external seed bytes\n');
    fs.symlinkSync(target, path.join(gw.fwSqlite, '.osi-sqlite3-candidate-owner'));
    const r = r2SeedHarness(gw);
    assert.equal(r.status, 0, r.stderr);
    if (present) assert.equal(fs.readFileSync(target, 'utf8'), 'external seed bytes\n');
    else assert.equal(fs.existsSync(target), false);
    assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
    assert.match(r.stderr, /already contains an ownership marker/);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-rollback.'), []);
    // The refused stage keeps its owner line and copied candidate; the next
    // run removes it before trying again.
    const stages = r2Names(gw, '.osi-sqlite3-seed-stage.');
    assert.equal(stages.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(gw.proj, 'node_modules', stages[0])).sort(),
      ['.owner', 'candidate']);
    const again = r2SeedHarness(gw);
    assert.ok(again.stderr.includes('removing seed stage left by an earlier attempt: ' +
      path.join(gw.proj, 'node_modules', stages[0])), again.stderr);
    assert.match(again.stdout, /SEED_RC=[1-9][0-9]*/);
    assert.equal(r2Names(gw, '.osi-sqlite3-seed-stage.').length, 1);
    if (present) assert.equal(fs.readFileSync(target, 'utf8'), 'external seed bytes\n');
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  }
});
test('R3 deploy final failure restores old module without a second lock fetch', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const lock = writeLockFixture(gw, LOCKED_VERSION);
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected final failure before lock reread");\n');
  const hook = 'fetch() { if [ -f "$TMP_DIR/first-fetch" ]; then echo SECOND_LOCK_READ >&2; return 22; fi; : > "$TMP_DIR/first-fetch"; command cp ' +
    r2Quote(lock) + ' "$2"; }';
  const r = r2DeployCall(gw, { lockFixture: lock, shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.doesNotMatch(r.stderr, /SECOND_LOCK_READ/);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
});
test('R3 seed final failure restores old module after the source lock disappears', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const sourceLock = path.join(gw.root, 'share', 'node-red', 'package-lock.json');
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') { require("fs").unlinkSync(' + JSON.stringify(sourceLock) +
    '); throw new Error("injected seed final failure after lock removal"); }\n');
  const r = r2SeedHarness(gw);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.equal(fs.existsSync(sourceLock), false);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-rollback.'), []);
});
test('R3 occupied deploy restore retains the marker and nested original for inspection', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected deploy final failure for occupied restore");\n');
  const hook = 'mv() { case "$1:$2" in */.osi-sqlite3-rollback.*/original:"$NODE_RED_ROOT/node_modules/sqlite3")' +
    ' mkdir -p "$2"; printf "occupant bytes\\n" > "$2/occupant.txt"; command mv "$@" || return $?; echo OCCUPIED_DEPLOY_RESTORE >&2; return 0 ;; esac; command mv "$@"; }';
  const r = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /OCCUPIED_DEPLOY_RESTORE/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.equal(fs.readFileSync(path.join(d, 'occupant.txt'), 'utf8'), 'occupant bytes\n');
  assert.deepEqual(fs.readFileSync(path.join(d, 'original', 'original.txt')), original);
  assert.equal(r2Names(gw, '.osi-sqlite3-rollback.').length, 1);
  assert.match(r.stderr, /restore identity differs/);
});
test('R3 occupied seed restore retains the marker and nested original for inspection', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected seed final failure for occupied restore");\n');
  const hook = 'mv() { case "$1:$2" in */.osi-sqlite3-seed-rollback.*/original:"$DST/node_modules/sqlite3")' +
    ' mkdir -p "$2"; printf "occupant bytes\\n" > "$2/occupant.txt"; command mv "$@" || return $?; echo OCCUPIED_SEED_RESTORE >&2; return 0 ;; esac; command mv "$@"; }';
  const r = r2SeedHarness(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /OCCUPIED_SEED_RESTORE/);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.equal(fs.readFileSync(path.join(d, 'occupant.txt'), 'utf8'), 'occupant bytes\n');
  assert.deepEqual(fs.readFileSync(path.join(d, 'original', 'original.txt')), original);
  assert.equal(r2Names(gw, '.osi-sqlite3-seed-rollback.').length, 1);
  assert.match(r.stderr, /restore identity differs/);
});
test('R3 early deploy recovery refuses an occupied restore before ordinary writes', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const interrupt = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/sqlite3:"*/.osi-sqlite3-rollback.*/original)' +
    ' command mv "$@" || return $?; echo INTERRUPT_EARLY_RESTORE >&2; exit 26 ;; esac; command mv "$@"; }';
  const first = r2DeployCall(gw, { shellHooks: [interrupt] });
  assert.equal(first.status, 26, first.stderr);
  assert.match(first.stderr, /INTERRUPT_EARLY_RESTORE/);
  assert.doesNotMatch(first.stdout, /AFTER_MATERIALIZE/);
  const occupy = 'mv() { case "$1:$2" in */.osi-sqlite3-rollback.*/original:"$NODE_RED_ROOT/node_modules/sqlite3")' +
    ' mkdir -p "$2"; printf "new occupant\\n" > "$2/new.txt"; command mv "$@" || return $?; echo OCCUPIED_EARLY_RESTORE >&2; return 0 ;; esac; command mv "$@"; }';
  const second = shellHarness(gw, [
    'if run_native_sqlite3_preflight; then echo PREFLIGHT_RC=0; echo ORDINARY_WRITE; else echo PREFLIGHT_RC=$?; fi',
    'echo AFTER_PREFLIGHT',
  ].join('\n'), { shellHooks: [occupy], fetchFails: true });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /OCCUPIED_EARLY_RESTORE/);
  assert.match(second.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.doesNotMatch(second.stdout, /ORDINARY_WRITE/);
  assert.equal(fs.readFileSync(path.join(d, 'new.txt'), 'utf8'), 'new occupant\n');
  assert.deepEqual(fs.readFileSync(path.join(d, 'original', 'original.txt')), original);
  assert.equal(r2Names(gw, '.osi-sqlite3-rollback.').length, 1);
});
test('R3 failing fallback-link probe preserves the old seed entry', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.rmSync(path.join(gw.proj, 'node_modules', 'fixture-peer'), { recursive: true, force: true });
  // The seed discards the probe's output, so the hook records its call in a
  // file the fixture owns, outside node_modules.
  const marker = path.join(gw.root, 'link-probe-hook.marker');
  assert.equal(fs.existsSync(marker), false);
  const hook = `seed_sqlite3_loads() {
    case "$1" in */.osi-sqlite3-seed-stage.*/link) printf 'LINK_PROBE_HOOK\\n' >> ${r2Quote(marker)}; return 17 ;; esac
    node -e '
      const sqlite3 = require(process.argv[1]);
      const db = new sqlite3.Database(":memory:", function (err) {
        if (err) { console.error("sqlite3 could not open :memory: -- " + (err && err.message ? err.message : err)); process.exit(1); }
        db.close(function () { process.exit(0); });
      });
    ' "$1" >/dev/null
  }`;
  const r = r2SeedHarness(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'LINK_PROBE_HOOK\n');
  assert.match(r.stderr, /ERROR: verified firmware-link fallback unavailable/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-rollback.'), []);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-stage.'), []);
});

// R4: a rollback directory that never received the original, or whose
// original was already put back, holds only owner metadata. The next run
// clears it without touching the final path and stops; the run after that is
// an ordinary eligible attempt. Directories that still hold an original, have
// a foreign owner, or are symlinks stay exactly as they were.
function r4Id(p) {
  const s = fs.lstatSync(p, { bigint: true });
  return `${s.dev}:${s.ino}`;
}
function r4Preflight(gw, opts = {}) {
  return shellHarness(gw, [
    'if run_native_sqlite3_preflight; then echo PREFLIGHT_RC=0; echo ORDINARY_WRITE; else echo PREFLIGHT_RC=$?; fi',
    'echo AFTER_PREFLIGHT',
  ].join('\n'), { lockFixture: writeLockFixture(gw, LOCKED_VERSION),
    arch: 'armv7l', muslGlob: muslPresent(gw), toolchain: false,
    shellHooks: opts.shellHooks || [] });
}
test('R4 dangling installed symlink still compares the firmware version before writes', () => {
  const gw = makeGateway('dangling-symlink');
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  const link = fs.readlinkSync(d);
  const bad = shellHarness(gw, PREFLIGHT_IN_CONDITION, {
    lockFixture: writeLockFixture(gw, '5.1.8'), arch: 'armv7l',
    muslGlob: muslPresent(gw), toolchain: false });
  assert.equal(bad.status, 0, bad.stderr);
  assert.match(bad.stdout, /PREFLIGHT-RC=[1-9]/, `${bad.stdout}${bad.stderr}`);
  assert.match(bad.stderr, /firmware sqlite3 is 5\.1\.7/);
  assert.match(bad.stderr, /5\.1\.8/);
  assert.equal(fs.readlinkSync(d), link);
  const good = shellHarness(gw, PREFLIGHT_IN_CONDITION, {
    lockFixture: writeLockFixture(gw, LOCKED_VERSION), arch: 'armv7l',
    muslGlob: muslPresent(gw), toolchain: false });
  assert.match(good.stdout, /PREFLIGHT-RC=0/, `${good.stdout}${good.stderr}`);
  assert.match(good.stdout, /firmware sqlite3 5\.1\.7 matches the shipped lockfile/);
});
test('R4 deploy metadata-only rollback after a failed or interrupted old-path rename clears and retries', () => {
  for (const fault of ['status', 'interrupt']) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const before = r4Id(d);
    const action = fault === 'status'
      ? 'echo OLD_MV_STATUS >&2; return 27' : 'echo OLD_MV_INTERRUPT >&2; exit 26';
    const hook = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/sqlite3:"*/.osi-sqlite3-rollback.*/original)' +
      ' ' + action + ' ;; esac; command mv "$@"; }';
    const first = r2DeployCall(gw, { shellHooks: [hook] });
    if (fault === 'status') {
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stderr, /OLD_MV_STATUS/);
      assert.match(first.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
    } else {
      assert.equal(first.status, 26, first.stderr);
      assert.match(first.stderr, /OLD_MV_INTERRUPT/);
      assert.doesNotMatch(first.stdout, /AFTER_MATERIALIZE/);
    }
    const names = r2Names(gw, '.osi-sqlite3-rollback.');
    assert.equal(names.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(gw.proj, 'node_modules', names[0])), ['.owner']);
    assert.equal(r2Names(gw, '.osi-sqlite3-stage.').length, 1);
    assert.equal(r4Id(d), before);
    const second = r4Preflight(gw);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
    assert.doesNotMatch(second.stdout, /ORDINARY_WRITE/);
    assert.match(second.stderr, /cleared metadata-only sqlite3 rollback/);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
    assert.equal(r4Id(d), before);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    const third = r2DeployCall(gw);
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /PREFLIGHT_RC=0/);
    assert.match(third.stdout, /MATERIALIZE_RC=0/);
    assert.match(third.stdout, /VERIFY_RC=0/);
    assert.match(third.stderr, /interrupted deploy/);
    assert.equal(requireSqlite3(gw.proj).status, 0);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-stage.'), []);
  }
});
test('R4 deploy truncated owner metadata and a partial cleanup converge to an eligible retry', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const before = r4Id(d);
  const b = path.join(gw.proj, 'node_modules', '.osi-sqlite3-rollback.partial');
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, '.owner'), 'osi-sqlite3-dep'); // interrupted owner write
  const rmdirHook = 'rmdir() { case "$1" in */.osi-sqlite3-rollback.*) echo RMDIR_HOOK >&2; return 31 ;; esac; command rmdir "$@"; }';
  const first = r4Preflight(gw, { shellHooks: [rmdirHook] });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /RMDIR_HOOK/);
  assert.match(first.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.doesNotMatch(first.stdout, /ORDINARY_WRITE/);
  assert.match(first.stderr, /cleanup failed or was partial/);
  assert.deepEqual(fs.readdirSync(b), []);
  const second = r4Preflight(gw);
  assert.match(second.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.match(second.stderr, /cleared metadata-only sqlite3 rollback/);
  assert.equal(fs.existsSync(b), false);
  assert.equal(r4Id(d), before);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  const third = r2DeployCall(gw);
  assert.match(third.stdout, /PREFLIGHT_RC=0/);
  assert.match(third.stdout, /MATERIALIZE_RC=0/);
  assert.match(third.stdout, /VERIFY_RC=0/);
});
test('R4 deploy leftover metadata after an already restored rollback clears without moving the restored module', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const index = path.join(gw.fwSqlite, 'index.js');
  const cleanIndex = fs.readFileSync(index);
  fs.appendFileSync(index, '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected final failure before rollback cleanup");\n');
  const hook = 'rm() { case "$1:$2" in "-rf:"*/.osi-sqlite3-rollback.*)' +
    ' echo RM_BACKUP_HOOK >&2; return 32 ;; esac; command rm "$@"; }';
  const first = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /RM_BACKUP_HOOK/);
  assert.match(first.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  const names = r2Names(gw, '.osi-sqlite3-rollback.');
  assert.equal(names.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(gw.proj, 'node_modules', names[0])), ['.owner']);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  const restored = r4Id(d);
  const second = r4Preflight(gw);
  assert.match(second.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.doesNotMatch(second.stdout, /ORDINARY_WRITE/);
  assert.match(second.stderr, /cleared metadata-only sqlite3 rollback/);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
  assert.equal(r4Id(d), restored);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  fs.writeFileSync(index, cleanIndex); // the image fault is gone before the retry
  const third = r2DeployCall(gw);
  assert.match(third.stdout, /MATERIALIZE_RC=0/);
  assert.match(third.stdout, /VERIFY_RC=0/);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
});
test('R4 deploy unsafe rollback states are retained, not cleared', () => {
  for (const fault of ['original-beside-unowned', 'symlink-backup', 'foreign-owner', 'truncated-owner-with-original']) {
    const gw = makeGateway('real-with-binary');
    const d = path.join(gw.proj, 'node_modules', 'sqlite3');
    const mods = path.dirname(d);
    const b = path.join(mods, '.osi-sqlite3-rollback.unsafe');
    const target = path.join(gw.root, 'symlinked-backup');
    if (fault === 'symlink-backup') {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, '.owner'), 'osi-sqlite3-deploy-v2\n');
      fs.symlinkSync(target, b);
    } else {
      fs.mkdirSync(b);
      fs.writeFileSync(path.join(b, '.owner'), {
        'original-beside-unowned': 'osi-sqlite3-deploy-v2\n',
        'foreign-owner': 'someone-else\n',
        'truncated-owner-with-original': 'osi-sqlite3',
      }[fault]);
      if (fault !== 'foreign-owner') {
        fs.mkdirSync(path.join(b, 'original'));
        fs.writeFileSync(path.join(b, 'original', 'kept.txt'), 'kept bytes\n');
      }
    }
    const before = fs.readdirSync(mods).sort();
    const bBefore = fs.readdirSync(b).sort();
    const dId = r4Id(d);
    const r = r4Preflight(gw);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PREFLIGHT_RC=[1-9][0-9]*/, fault);
    assert.doesNotMatch(r.stdout, /ORDINARY_WRITE/, fault);
    assert.doesNotMatch(r.stderr, /cleared/, fault);
    assert.deepEqual(fs.readdirSync(mods).sort(), before, fault);
    assert.deepEqual(fs.readdirSync(b).sort(), bBefore, fault);
    assert.equal(r4Id(d), dId, fault);
    if (fault === 'symlink-backup') assert.equal(fs.lstatSync(b).isSymbolicLink(), true);
    if (fault === 'original-beside-unowned' || fault === 'truncated-owner-with-original')
      assert.equal(fs.readFileSync(path.join(b, 'original', 'kept.txt'), 'utf8'), 'kept bytes\n');
  }
});
test('R4 seed metadata-only rollback after a failed or interrupted old-path rename clears and retries', () => {
  for (const fault of ['status', 'interrupt']) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const peer = path.join(gw.proj, 'node_modules', 'node-red-node-sqlite');
    fs.mkdirSync(peer, { recursive: true });
    fs.writeFileSync(path.join(peer, 'peer.txt'), 'peer bytes\n');
    const before = r4Id(d);
    const action = fault === 'status'
      ? 'echo SEED_OLD_MV_STATUS >&2; return 27' : 'echo SEED_OLD_MV_INTERRUPT >&2; exit 26';
    const hook = 'mv() { case "$1:$2" in "$DST/node_modules/sqlite3:"*/.osi-sqlite3-seed-rollback.*/original)' +
      ' ' + action + ' ;; esac; command mv "$@"; }';
    const first = r2SeedHarness(gw, { shellHooks: [hook] });
    if (fault === 'status') {
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stderr, /SEED_OLD_MV_STATUS/);
      assert.match(first.stdout, /SEED_RC=[1-9][0-9]*/);
    } else {
      assert.equal(first.status, 26, first.stderr);
      assert.match(first.stderr, /SEED_OLD_MV_INTERRUPT/);
      assert.doesNotMatch(first.stdout, /AFTER_SEED/);
    }
    const names = r2Names(gw, '.osi-sqlite3-seed-rollback.');
    assert.equal(names.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(gw.proj, 'node_modules', names[0])).sort(),
      ['.candidate-id', '.owner']);
    assert.equal(r2Names(gw, '.osi-sqlite3-seed-stage.').length, 1);
    assert.equal(r4Id(d), before);
    const second = r2SeedHarness(gw);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /SEED_RC=[1-9][0-9]*/);
    assert.match(second.stderr, /cleared metadata-only seed rollback/);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-rollback.'), []);
    assert.equal(r4Id(d), before);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n');
    const third = r2SeedHarness(gw);
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /SEED_RC=0/);
    assert.equal(requireSqlite3(gw.proj).status, 0);
    assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n');
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-'), []);
  }
});
test('R4 seed partial candidate identity is metadata only and clears before an eligible retry', () => {
  for (const id of ['', '2049:1234']) {
    const gw = makeGateway('real-with-binary');
    const { d, original } = r2OldBytes(gw);
    const before = r4Id(d);
    const b = path.join(gw.proj, 'node_modules', '.osi-sqlite3-seed-rollback.partial');
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, '.owner'), 'osi-sqlite3-seed-v2\n');
    fs.writeFileSync(path.join(b, '.candidate-id'), id); // interrupted identity write
    const second = r2SeedHarness(gw);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /SEED_RC=[1-9][0-9]*/, JSON.stringify(id));
    assert.match(second.stderr, /cleared metadata-only seed rollback/);
    assert.equal(fs.existsSync(b), false);
    assert.equal(r4Id(d), before);
    const third = r2SeedHarness(gw);
    assert.match(third.stdout, /SEED_RC=0/);
    assert.match(third.stdout, /existing real sqlite3 matches image pin and loads/);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.equal(r4Id(d), before);
  }
});
test('R4 seed stage with only an interrupted owner write is removed; a stage with payload and no owner is retained', () => {
  const gw = makeGateway('real-with-binary');
  const mods = path.join(gw.proj, 'node_modules');
  const partial = path.join(mods, '.osi-sqlite3-seed-stage.partial');
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, '.owner'), 'osi-sqlite3-seed-st');
  const r = r2SeedHarness(gw);
  assert.match(r.stdout, /SEED_RC=0/, r.stderr);
  assert.equal(fs.existsSync(partial), false);
  const unowned = path.join(mods, '.osi-sqlite3-seed-stage.unowned');
  fs.mkdirSync(path.join(unowned, 'candidate'), { recursive: true });
  fs.writeFileSync(path.join(unowned, 'candidate', 'kept.txt'), 'kept bytes\n');
  const refused = r2SeedHarness(gw);
  assert.match(refused.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.match(refused.stderr, /unowned seed stage/);
  assert.equal(fs.readFileSync(path.join(unowned, 'candidate', 'kept.txt'), 'utf8'), 'kept bytes\n');
});
test('R4 seed unsafe rollback states are retained, not cleared', () => {
  for (const fault of ['original-beside-unowned', 'foreign-owner', 'identity-beside-truncated-owner', 'partial-identity-with-original']) {
    const gw = makeGateway('real-with-binary');
    const d = path.join(gw.proj, 'node_modules', 'sqlite3');
    const mods = path.dirname(d);
    const b = path.join(mods, '.osi-sqlite3-seed-rollback.unsafe');
    fs.mkdirSync(b);
    const files = {
      'original-beside-unowned': { '.owner': 'osi-sqlite3-seed-v2\n', '.candidate-id': '1:2:3\n' },
      'foreign-owner': { '.owner': 'someone-else\n' },
      'identity-beside-truncated-owner': { '.owner': 'osi-sqlite3', '.candidate-id': '1:2:3\n' },
      'partial-identity-with-original': { '.owner': 'osi-sqlite3-seed-v2\n', '.candidate-id': '1:2' },
    }[fault];
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(b, name), value);
    if (fault === 'original-beside-unowned' || fault === 'partial-identity-with-original') {
      fs.mkdirSync(path.join(b, 'original'));
      fs.writeFileSync(path.join(b, 'original', 'kept.txt'), 'kept bytes\n');
    }
    const before = fs.readdirSync(mods).sort();
    const bBefore = fs.readdirSync(b).sort();
    const dId = r4Id(d);
    const r = r2SeedHarness(gw);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/, fault);
    assert.doesNotMatch(r.stderr, /cleared/, fault);
    assert.deepEqual(fs.readdirSync(mods).sort(), before, fault);
    assert.deepEqual(fs.readdirSync(b).sort(), bBefore, fault);
    assert.equal(r4Id(d), dId, fault);
    if (fault === 'original-beside-unowned' || fault === 'partial-identity-with-original')
      assert.equal(fs.readFileSync(path.join(b, 'original', 'kept.txt'), 'utf8'), 'kept bytes\n');
  }
});

// R5: a restore that found the final path occupied moved the original to
// <final>/original and kept its rollback directory, which now holds only
// metadata. Every later run must keep refusing. Clearing that directory would
// let the next ordinary repair move the occupant, with the original inside it,
// into a new rollback directory and delete it after a successful promotion.
// The image fault is removed first, so such a repair would succeed.
function r5Snapshot(gw, prefix) {
  const mods = path.join(gw.proj, 'node_modules');
  const d = path.join(mods, 'sqlite3');
  const nested = path.join(d, 'original');
  const backups = r2Names(gw, prefix);
  assert.equal(backups.length, 1);
  const b = path.join(mods, backups[0]);
  return {
    modules: fs.readdirSync(mods).sort(),
    backup: fs.readdirSync(b).sort().map(n => [n, fs.readFileSync(path.join(b, n), 'latin1')]),
    finalId: r4Id(d),
    finalChildren: fs.readdirSync(d).sort(),
    occupant: fs.readFileSync(path.join(d, 'occupant.txt'), 'latin1'),
    nestedId: r4Id(nested),
    nestedChildren: fs.readdirSync(nested).sort(),
    nestedOriginal: fs.readFileSync(path.join(nested, 'original.txt'), 'latin1'),
  };
}
test('R5 deploy occupied restore stays refused across fresh invocations', () => {
  for (const origin of ['final-failure', 'early']) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const index = path.join(gw.fwSqlite, 'index.js');
    const cleanIndex = fs.readFileSync(index);
    const occupy = 'mv() { case "$1:$2" in */.osi-sqlite3-rollback.*/original:"$NODE_RED_ROOT/node_modules/sqlite3")' +
      ' mkdir -p "$2"; printf "occupant bytes\\n" > "$2/occupant.txt"; command mv "$@" || return $?; echo R5_OCCUPIED_DEPLOY_RESTORE >&2; return 0 ;; esac; command mv "$@"; }';
    let refused;
    if (origin === 'final-failure') {
      fs.appendFileSync(index, '\nif (__dirname === ' + JSON.stringify(d) +
        ') throw new Error("injected deploy final failure for occupied restore");\n');
      refused = r2DeployCall(gw, { shellHooks: [occupy] });
      assert.match(refused.stdout, /MATERIALIZE_RC=[1-9][0-9]*/, origin);
    } else {
      const interrupt = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/sqlite3:"*/.osi-sqlite3-rollback.*/original)' +
        ' command mv "$@" || return $?; echo R5_DEPLOY_INTERRUPT_AFTER_OLD >&2; exit 26 ;; esac; command mv "$@"; }';
      const first = r2DeployCall(gw, { shellHooks: [interrupt] });
      assert.equal(first.status, 26, first.stderr);
      assert.match(first.stderr, /R5_DEPLOY_INTERRUPT_AFTER_OLD/);
      refused = r4Preflight(gw, { shellHooks: [occupy] });
      assert.match(refused.stdout, /PREFLIGHT_RC=[1-9][0-9]*/, origin);
      assert.doesNotMatch(refused.stdout, /ORDINARY_WRITE/, origin);
    }
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.stderr, /R5_OCCUPIED_DEPLOY_RESTORE/, origin);
    assert.match(refused.stderr, /restore identity differs/, origin);
    fs.writeFileSync(index, cleanIndex); // an ordinary repair would now succeed
    const snapshot = r5Snapshot(gw, '.osi-sqlite3-rollback.');
    assert.deepEqual(snapshot.backup, [['.owner', 'osi-sqlite3-deploy-v2\n']], origin);
    assert.deepEqual(snapshot.finalChildren, ['occupant.txt', 'original'], origin);
    assert.equal(snapshot.occupant, 'occupant bytes\n', origin);
    assert.equal(snapshot.nestedOriginal, original.toString('latin1'), origin);
    for (const run of ['preflight', 'full deploy']) {
      const r = run === 'preflight' ? r4Preflight(gw) : r2DeployCall(gw);
      const label = `${origin}: ${run}`;
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /PREFLIGHT_RC=[1-9][0-9]*/, label);
      assert.doesNotMatch(r.stdout, /ORDINARY_WRITE/, label);
      assert.doesNotMatch(r.stderr, /cleared/, label);
      assert.match(r.stderr, /original is present beside metadata-only rollback/, label);
      if (run === 'full deploy') {
        assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/, label);
        assert.match(r.stderr, /rollback appeared after preflight/, label);
        assert.doesNotMatch(r.stdout, /OK: materialised/, label);
      }
      assert.deepEqual(r5Snapshot(gw, '.osi-sqlite3-rollback.'), snapshot, label);
    }
  }
});
test('R5 seed occupied restore stays refused across fresh invocations', () => {
  for (const origin of ['final-failure', 'early']) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const peer = path.join(gw.proj, 'node_modules', 'node-red-node-sqlite');
    fs.mkdirSync(peer, { recursive: true });
    fs.writeFileSync(path.join(peer, 'peer.txt'), 'peer bytes\n');
    const index = path.join(gw.fwSqlite, 'index.js');
    const cleanIndex = fs.readFileSync(index);
    const occupy = 'mv() { case "$1:$2" in */.osi-sqlite3-seed-rollback.*/original:"$DST/node_modules/sqlite3")' +
      ' mkdir -p "$2"; printf "occupant bytes\\n" > "$2/occupant.txt"; command mv "$@" || return $?; echo R5_OCCUPIED_SEED_RESTORE >&2; return 0 ;; esac; command mv "$@"; }';
    if (origin === 'final-failure') {
      fs.appendFileSync(index, '\nif (__dirname === ' + JSON.stringify(d) +
        ') throw new Error("injected seed final failure for occupied restore");\n');
    } else {
      const interrupt = 'mv() { case "$1:$2" in "$DST/node_modules/sqlite3:"*/.osi-sqlite3-seed-rollback.*/original)' +
        ' command mv "$@" || return $?; echo R5_SEED_INTERRUPT_AFTER_OLD >&2; exit 26 ;; esac; command mv "$@"; }';
      const first = r2SeedHarness(gw, { shellHooks: [interrupt] });
      assert.equal(first.status, 26, first.stderr);
      assert.match(first.stderr, /R5_SEED_INTERRUPT_AFTER_OLD/);
    }
    const refused = r2SeedHarness(gw, { shellHooks: [occupy] });
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.stdout, /SEED_RC=[1-9][0-9]*/, origin);
    assert.match(refused.stderr, /R5_OCCUPIED_SEED_RESTORE/, origin);
    assert.match(refused.stderr, /restore identity differs/, origin);
    fs.writeFileSync(index, cleanIndex); // an ordinary seed would now succeed
    const snapshot = r5Snapshot(gw, '.osi-sqlite3-seed-rollback.');
    assert.deepEqual(snapshot.backup.map(([n]) => n), ['.candidate-id', '.owner'], origin);
    assert.equal(snapshot.backup[1][1], 'osi-sqlite3-seed-v2\n', origin);
    assert.deepEqual(snapshot.finalChildren, ['occupant.txt', 'original'], origin);
    assert.equal(snapshot.occupant, 'occupant bytes\n', origin);
    assert.equal(snapshot.nestedOriginal, original.toString('latin1'), origin);
    for (const boot of ['next boot', 'boot after that']) {
      const r = r2SeedHarness(gw);
      const label = `${origin}: ${boot}`;
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/, label);
      assert.doesNotMatch(r.stdout, /OK: (seeded|existing)/, label);
      assert.doesNotMatch(r.stderr, /cleared/, label);
      assert.match(r.stderr, /original is present beside metadata-only seed rollback/, label);
      assert.deepEqual(r5Snapshot(gw, '.osi-sqlite3-seed-rollback.'), snapshot, label);
      assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n', label);
    }
  }
});

// R7: deploy and the seed keep separate rollback prefixes, and each now
// refuses, before it moves or deletes anything, while an entry under the
// other's prefix exists. After an occupied restore the original sits nested
// in the final path beside a metadata-only rollback. Before R7 the other tool
// took that final for a broken module, moved it into its own rollback and
// deleted it after a successful repair.
function r7Snapshot(gw, prefix) {
  const snapshot = r5Snapshot(gw, prefix);
  const b = path.join(gw.proj, 'node_modules', r2Names(gw, prefix)[0]);
  return { ...snapshot, backupId: r4Id(b) };
}
function r7AssertDeployRefused(r, label, full) {
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT_RC=[1-9][0-9]*/, label);
  assert.doesNotMatch(r.stdout, /PREFLIGHT_RC=0|ORDINARY_WRITE/, label);
  assert.match(r.stderr, /ERROR: seed sqlite3 rollback present: /, label);
  if (full) {
    assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/, label);
    assert.doesNotMatch(r.stdout, /MATERIALIZE_RC=0|VERIFY_RC=/, label);
  }
  assert.doesNotMatch(r.stdout + r.stderr, /OK: materialised|cleared|restored|rolled back/, label);
}
function r7AssertSeedRefused(r, label) {
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/, label);
  assert.match(r.stdout, /AFTER_SEED/, label);
  assert.match(r.stderr, /ERROR: deploy sqlite3 rollback present: /, label);
  assert.doesNotMatch(r.stdout + r.stderr, /SEED_RC=0|OK: (seeded|existing)|cleared|restored|rolled back/, label);
}
function r7OccupiedRestore(firstTool) {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const index = path.join(gw.fwSqlite, 'index.js');
  const cleanIndex = fs.readFileSync(index);
  fs.appendFileSync(index, '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected final failure for occupied restore");\n');
  const prefix = firstTool === 'seed' ? '.osi-sqlite3-seed-rollback.' : '.osi-sqlite3-rollback.';
  const target = firstTool === 'seed' ? '$DST' : '$NODE_RED_ROOT';
  const occupy = 'mv() { case "$1:$2" in */' + prefix + '*/original:"' + target + '/node_modules/sqlite3")' +
    ' mkdir -p "$2"; printf "occupant bytes\\n" > "$2/occupant.txt"; command mv "$@" || return $?; echo R7_OCCUPIED_RESTORE >&2; return 0 ;; esac; command mv "$@"; }';
  const first = firstTool === 'seed'
    ? r2SeedHarness(gw, { shellHooks: [occupy] }) : r2DeployCall(gw, { shellHooks: [occupy] });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, firstTool === 'seed' ? /SEED_RC=[1-9][0-9]*/ : /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.match(first.stderr, /R7_OCCUPIED_RESTORE/);
  assert.match(first.stderr, /restore identity differs/);
  fs.writeFileSync(index, cleanIndex); // an ordinary repair by either tool would now succeed
  const snapshot = r7Snapshot(gw, prefix);
  assert.deepEqual(snapshot.backup.map(([n]) => n),
    firstTool === 'seed' ? ['.candidate-id', '.owner'] : ['.owner']);
  assert.deepEqual(snapshot.finalChildren, ['occupant.txt', 'original']);
  assert.equal(snapshot.occupant, 'occupant bytes\n');
  assert.equal(snapshot.nestedOriginal, original.toString('latin1'));
  const otherPrefixes = firstTool === 'seed'
    ? ['.osi-sqlite3-rollback.', '.osi-sqlite3-stage.'] : ['.osi-sqlite3-seed-'];
  const otherRuns = firstTool === 'seed'
    ? [['later deploy preflight', () => r4Preflight(gw), (r, l) => r7AssertDeployRefused(r, l, false)],
      ['later full deploy', () => r2DeployCall(gw, { verify: false }), (r, l) => r7AssertDeployRefused(r, l, true)]]
    : [['later seed next boot', () => r2SeedHarness(gw), r7AssertSeedRefused],
      ['later seed boot after that', () => r2SeedHarness(gw), r7AssertSeedRefused]];
  for (const [label, run, check] of otherRuns) {
    check(run(), label);
    for (const p of otherPrefixes) assert.deepEqual(r2Names(gw, p), [], label);
    assert.deepEqual(r7Snapshot(gw, prefix), snapshot, label);
  }
  const ownRuns = firstTool === 'seed' ? ['seed retry', 'seed retry again'] : ['deploy preflight retry', 'full deploy retry'];
  for (const label of ownRuns) {
    if (firstTool === 'seed') {
      const r = r2SeedHarness(gw);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/, label);
      assert.doesNotMatch(r.stdout, /OK: (seeded|existing)/, label);
      assert.match(r.stderr, /original is present beside metadata-only seed rollback/, label);
      assert.doesNotMatch(r.stderr, /cleared/, label);
    } else {
      const full = label === 'full deploy retry';
      const r = full ? r2DeployCall(gw, { verify: false }) : r4Preflight(gw);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /PREFLIGHT_RC=[1-9][0-9]*/, label);
      assert.doesNotMatch(r.stdout, /ORDINARY_WRITE/, label);
      assert.match(r.stderr, /original is present beside metadata-only rollback/, label);
      assert.doesNotMatch(r.stderr, /cleared/, label);
      if (full) {
        assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/, label);
        assert.match(r.stderr, /rollback appeared after preflight/, label);
        assert.doesNotMatch(r.stdout, /OK: materialised|VERIFY_RC=/, label);
      }
    }
    assert.deepEqual(r7Snapshot(gw, prefix), snapshot, label);
  }
}
test('R7 seed occupied restore stays refused across later deploys and seeds', () => r7OccupiedRestore('seed'));
test('R7 deploy occupied restore stays refused across later seeds and deploys', () => r7OccupiedRestore('deploy'));
test('R7 every entry type under the other rollback prefix blocks both tools before changes', () => {
  for (const tool of ['deploy', 'seed']) {
    for (const kind of ['dangling-symlink', 'file', 'fifo', 'directory']) {
      const label = `${tool}: ${kind}`;
      const gw = makeGateway('real-without-binary');
      const { d, original } = r2OldBytes(gw);
      const mods = path.join(gw.proj, 'node_modules');
      const f = path.join(mods, (tool === 'deploy' ? '.osi-sqlite3-seed-rollback.' : '.osi-sqlite3-rollback.') + 'r7');
      if (kind === 'dangling-symlink') fs.symlinkSync(path.join(gw.root, 'r7-absent-target'), f);
      else if (kind === 'file') fs.writeFileSync(f, 'foreign bytes\n');
      else if (kind === 'fifo') assert.equal(spawnSync('mkfifo', [f]).status, 0, label);
      else {
        fs.mkdirSync(path.join(f, 'original'), { recursive: true });
        fs.writeFileSync(path.join(f, 'original', 'kept.txt'), 'kept bytes\n');
      }
      const state = () => {
        const s = fs.lstatSync(f, { bigint: true });
        return {
          modules: fs.readdirSync(mods).sort(),
          entry: [s.dev, s.ino, s.mode].join(':'),
          link: kind === 'dangling-symlink' ? fs.readlinkSync(f) : null,
          bytes: kind === 'file' ? fs.readFileSync(f, 'latin1')
            : (kind === 'directory' ? fs.readFileSync(path.join(f, 'original', 'kept.txt'), 'latin1') : null),
          finalId: r4Id(d),
          finalChildren: fs.readdirSync(d).sort(),
          original: fs.readFileSync(path.join(d, 'original.txt'), 'latin1'),
        };
      };
      const before = state();
      assert.equal(before.original, original.toString('latin1'), label);
      if (tool === 'deploy') {
        r7AssertDeployRefused(r4Preflight(gw), label + ' preflight', false);
        assert.deepEqual(state(), before, label + ' preflight');
        const m = shellHarness(gw,
          'if materialize_native_sqlite3; then echo MATERIALIZE_RC=0; else echo MATERIALIZE_RC=$?; fi',
          { arch: 'armv7l', muslGlob: muslPresent(gw), toolchain: false });
        assert.equal(m.status, 0, m.stderr);
        assert.match(m.stdout, /MATERIALIZE_RC=[1-9][0-9]*/, label + ' materialise');
        assert.match(m.stderr, /ERROR: seed sqlite3 rollback present: /, label + ' materialise');
        assert.doesNotMatch(m.stdout, /MATERIALIZE_RC=0|OK: materialised/, label + ' materialise');
        assert.deepEqual(state(), before, label + ' materialise');
        r7AssertDeployRefused(r2DeployCall(gw, { verify: false }), label + ' full deploy', true);
        assert.deepEqual(state(), before, label + ' full deploy');
      } else {
        for (const boot of ['next boot', 'boot after that']) {
          r7AssertSeedRefused(r2SeedHarness(gw), `${label}: ${boot}`);
          assert.deepEqual(state(), before, `${label}: ${boot}`);
        }
      }
    }
  }
});
test('R7 an interrupted swap is left for the tool that made it', () => {
  for (const firstTool of ['seed', 'deploy']) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const originalId = r4Id(d);
    const prefix = firstTool === 'seed' ? '.osi-sqlite3-seed-rollback.' : '.osi-sqlite3-rollback.';
    const source = firstTool === 'seed' ? '$DST' : '$NODE_RED_ROOT';
    const interrupt = 'mv() { case "$1:$2" in "' + source + '/node_modules/sqlite3:"*/' + prefix + '*/original)' +
      ' command mv "$@" || return $?; echo R7_INTERRUPT_AFTER_OLD >&2; exit 26 ;; esac; command mv "$@"; }';
    const first = firstTool === 'seed'
      ? r2SeedHarness(gw, { shellHooks: [interrupt] }) : r2DeployCall(gw, { shellHooks: [interrupt] });
    assert.equal(first.status, 26, first.stderr);
    assert.match(first.stderr, /R7_INTERRUPT_AFTER_OLD/);
    assert.equal(fs.existsSync(d) || isSymlink(d), false, firstTool);
    const names = r2Names(gw, prefix);
    assert.equal(names.length, 1, firstTool);
    const b = path.join(gw.proj, 'node_modules', names[0]);
    assert.equal(r4Id(path.join(b, 'original')), originalId, firstTool);
    const held = () => ({
      modules: fs.readdirSync(path.join(gw.proj, 'node_modules')).sort(),
      backupId: r4Id(b),
      backup: fs.readdirSync(b).sort(),
      originalId: r4Id(path.join(b, 'original')),
      originalBytes: fs.readFileSync(path.join(b, 'original', 'original.txt'), 'latin1'),
      finalPresent: fs.existsSync(d) || isSymlink(d),
    });
    const before = held();
    if (firstTool === 'seed') r7AssertDeployRefused(r2DeployCall(gw, { verify: false }), 'deploy after interrupted seed', true);
    else r7AssertSeedRefused(r2SeedHarness(gw), 'seed after interrupted deploy');
    assert.deepEqual(held(), before, firstTool);
    const restore = firstTool === 'seed' ? r2SeedHarness(gw) : r4Preflight(gw);
    assert.equal(restore.status, 0, restore.stderr);
    assert.match(restore.stdout, firstTool === 'seed' ? /SEED_RC=[1-9][0-9]*/ : /PREFLIGHT_RC=[1-9][0-9]*/, firstTool);
    assert.match(restore.stderr, firstTool === 'seed' ? /restored interrupted seed swap/ : /restored interrupted sqlite3 swap/, firstTool);
    assert.equal(r4Id(d), originalId, firstTool);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.deepEqual(r2Names(gw, prefix), [], firstTool);
    const repair = firstTool === 'seed' ? r2SeedHarness(gw) : r2DeployCall(gw);
    const after = firstTool === 'seed' ? r2DeployCall(gw) : r2SeedHarness(gw);
    for (const [r, tool] of [[repair, firstTool], [after, firstTool === 'seed' ? 'deploy' : 'seed']]) {
      const label = `${firstTool} first: ${tool}`;
      assert.equal(r.status, 0, r.stderr);
      if (tool === 'seed') assert.match(r.stdout, /SEED_RC=0/, label);
      else {
        assert.match(r.stdout, /PREFLIGHT_RC=0/, label);
        assert.match(r.stdout, /MATERIALIZE_RC=0/, label);
        assert.match(r.stdout, /VERIFY_RC=0/, label);
      }
    }
    assert.equal(requireSqlite3(gw.proj).status, 0, firstTool);
    for (const p of ['.osi-sqlite3-rollback.', '.osi-sqlite3-seed-rollback.']) assert.deepEqual(r2Names(gw, p), [], firstTool);
  }
});
