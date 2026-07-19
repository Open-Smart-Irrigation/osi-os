'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const profiles = ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709'];
const copies = [
  ['scripts/lib/deployment-state.js', 'usr/libexec/osi-deployment-state.js', 0o644],
  ['scripts/deployment-state-cli.js', 'usr/libexec/osi-deployment-state-cli.js', 0o755],
  ['scripts/node-red-guarded-launch.js', 'usr/libexec/osi-node-red-guarded-launch.js', 0o755],
  ['scripts/deployment-inhibit.sh', 'usr/libexec/osi-deployment-inhibit.sh', 0o755],
  ['scripts/lib/factory-database-seed.js', 'usr/libexec/osi-factory-database-seed.js', 0o644],
  ['scripts/factory-database-seed-cli.js', 'usr/libexec/osi-factory-database-seed-cli.js', 0o755],
  ['scripts/audit-command-ack-state.js', 'usr/libexec/osi-audit-command-ack-state.js', 0o755],
  ['scripts/current-role-state.js', 'usr/libexec/osi-current-role-state', 0o755],
  ['scripts/record-role-start.js', 'usr/libexec/osi-record-role-start', 0o755],
  ['scripts/sync-protocol-capability-cli.js', 'usr/libexec/osi-sync-protocol-capability-cli.js', 0o755],
  ['scripts/pi/run-staged-npm-ci.sh', 'usr/libexec/osi-run-staged-npm-ci.sh', 0o755],
  ['scripts/pi/backup-pre-deploy.sh', 'usr/libexec/osi-backup-pre-deploy.sh', 0o755],
  ['scripts/pi/restore-pre-deploy.sh', 'usr/libexec/osi-restore-pre-deploy.sh', 0o755],
  ['scripts/pi/pre-deploy-database-helper.js', 'usr/libexec/osi-pre-deploy-database-helper.js', 0o755],
];

function readableEntries(root) {
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (stat.isSymbolicLink()) return [[root, fs.readlinkSync(root)]];
  if (stat.isFile()) return [[root, fs.readFileSync(root, 'utf8')]];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(root).flatMap((name) => readableEntries(path.join(root, name)));
}

test('every allocated resident primitive is byte-identical in both profiles with the intended mode', () => {
  for (const [source, relative, mode] of copies) {
    const expected = fs.readFileSync(path.join(repo, source));
    for (const profile of profiles) {
      const resident = path.join(repo, 'conf', profile, 'files', relative);
      assert.deepEqual(fs.readFileSync(resident), expected, `${profile}/${relative}`);
      assert.equal(fs.statSync(resident).mode & 0o777, mode, `${profile}/${relative} mode`);
    }
  }
});

test('pinned root-helper tool paths are backed by both shipped package profiles', () => {
  for (const profile of profiles) {
    const config = fs.readFileSync(path.join(repo, 'conf', profile, '.config'), 'utf8');
    assert.match(config, /^CONFIG_PACKAGE_node=y$/m, `${profile} ships /usr/bin/node`);
    assert.match(config, /^CONFIG_PACKAGE_sqlite3-cli=y$/m, `${profile} ships /usr/bin/sqlite3`);
    assert.match(config, /^CONFIG_PACKAGE_busybox=y$/m, `${profile} ships BusyBox`);
    assert.match(config, /^CONFIG_BUSYBOX_DEFAULT_RM=y$/m, `${profile} ships /bin/rm applet`);
  }
  assert.match(fs.readFileSync(path.join(repo, 'scripts/audit-command-ack-state.js'), 'utf8'),
    /const SQLITE3 = '\/usr\/bin\/sqlite3'/);
  const inhibitor = fs.readFileSync(path.join(repo, 'scripts/deployment-inhibit.sh'), 'utf8');
  assert.match(inhibitor, /^NODE=\/usr\/bin\/node$/m);
  assert.match(inhibitor, /^RM=\/bin\/rm$/m);
});

test('resident deployment CLI resolves the adjacent resident library', () => {
  for (const profile of profiles) {
    const cli = path.join(repo, 'conf', profile, 'files/usr/libexec/osi-deployment-state-cli.js');
    const result = cp.spawnSync(process.execPath, [cli, 'status', '--state', '/does/not/exist', '--receipts', '/does/not/exist', '--deployment-id', 'x'], { encoding: 'utf8' });
    assert.notEqual(result.status, null);
    assert.doesNotMatch(result.stderr, /Cannot find module/);
  }
});

test('both profiles ship the same dormant inhibitor init candidate without an S01 activation link', () => {
  const candidates = profiles.map((profile) => path.join(repo, 'conf', profile, 'files/etc/init.d/osi-deployment-inhibit'));
  assert.deepEqual(fs.readFileSync(candidates[0]), fs.readFileSync(candidates[1]));
  for (const [index, candidate] of candidates.entries()) {
    assert.equal(fs.statSync(candidate).mode & 0o777, 0o755);
    const rcLink = path.join(repo, 'conf', profiles[index], 'files/etc/rc.d/S01osi-deployment-inhibit');
    assert.equal(fs.existsSync(rcLink), false, `${profiles[index]} must not activate the dormant candidate`);
    assert.equal(fs.lstatSync(candidate).isFile(), true);
  }
});

test('no shipped init, uci-default, deploy, workflow, or pipeline caller names a dormant commit-1 addition', () => {
  const forbiddenRoots = ['deploy.sh', '.github/workflows', 'scripts/pipeline'];
  for (const profile of profiles) {
    forbiddenRoots.push(`conf/${profile}/files/etc/init.d`);
    forbiddenRoots.push(`conf/${profile}/files/etc/uci-defaults`);
    forbiddenRoots.push(`conf/${profile}/files/etc/rc.d`);
  }
  const patterns = ['osi-deployment-inhibit', 'osi-node-red-guarded-launch', 'osi-deployment-state-cli', 'osi-factory-database-seed-cli', 'osi-audit-command-ack-state', 'osi-record-role-start', 'osi-sync-protocol-capability-cli', 'osi-run-staged-npm-ci', 'osi-backup-pre-deploy', 'osi-restore-pre-deploy', 'osi-pre-deploy-database-helper'];
  for (const root of forbiddenRoots) {
    const absolute = path.join(repo, root);
    for (const [file, source] of readableEntries(absolute)) {
      if (file.endsWith('/etc/init.d/osi-deployment-inhibit')) continue;
      // Commit 2 makes the pre-94 ROM initializer invoke the trusted state
      // CLI for the image-baseline handoff; this is the sole intended caller
      // before the full runtime tranche lands.
      if (file.endsWith('/etc/uci-defaults/93_osi_deploy_guard_init')) continue;
      for (const pattern of patterns) assert.doesNotMatch(source, new RegExp(pattern), `${file} unexpectedly calls ${pattern}`);
    }
  }
});

test('no shipped caller activates the dormant purpose-bound backup/restore extension', () => {
  for (const root of ['deploy.sh', '.github/workflows', 'scripts/pipeline']) {
    for (const [file, source] of readableEntries(path.join(repo, root))) {
      assert.doesNotMatch(source, /(?:snapshot|restore)\s+--purpose\s+(?:command-ledger-disposition|general-database-restore|database-integrity-recovery)/, `${file} activates a dormant helper extension`);
    }
  }
});
