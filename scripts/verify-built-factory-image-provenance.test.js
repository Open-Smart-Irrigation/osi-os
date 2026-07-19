'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const verifier = require('./verify-built-factory-image-provenance');

const repo = path.resolve(__dirname, '..');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-built-rootfs-'));
  const source = path.join(repo, 'conf/full_raspberrypi_bcm27xx_bcm2712/files');
  for (const rel of ['usr/share/osi-deploy/image-guard-manifest.json', 'usr/share/osi-deploy/factory-image-provenance.json',
    'usr/share/db/farming.db', 'etc/uci-defaults/93_osi_deploy_guard_init', 'etc/uci-defaults/97_osi_db_seed',
    'usr/libexec/osi-factory-database-seed.js', 'usr/libexec/osi-factory-database-seed-cli.js',
    'usr/libexec/osi-deployment-state-cli.js', 'usr/libexec/osi-deployment-state.js', 'usr/libexec/osi-audit-command-ack-state.js',
    'usr/libexec/osi-sync-protocol-capability-cli.js', 'usr/libexec/osi-factory-image-provenance.js',
    'usr/libexec/osi-factory-image-provenance-cli.js']) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, rel), target);
  }
  for (const rel of ['osi-db-integrity', 'osi-identityd', 'osi-bootstrap']) {
    const target = path.join(root, 'etc/init.d', rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, 'etc/init.d', rel), target);
  }
  const nodeRed = path.join(root, 'etc/init.d/node-red');
  fs.copyFileSync(path.join(repo, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init'), nodeRed);
  fs.chmodSync(nodeRed, 0o755);
  for (const [name, target] of Object.entries({
    'S90osi-db-integrity': '../init.d/osi-db-integrity', 'S98osi-identityd': '../init.d/osi-identityd',
    'K98osi-identityd': '../init.d/osi-identityd', 'S99node-red': '../init.d/node-red',
    'K99node-red': '../init.d/node-red', 'S99osi-bootstrap': '../init.d/osi-bootstrap',
  })) {
    fs.mkdirSync(path.join(root, 'etc/rc.d'), { recursive: true });
    fs.symlinkSync(target, path.join(root, 'etc/rc.d', name));
  }
  return root;
}

test('built-rootfs verifier accepts exact mounted image paths', () => {
  const root = fixture();
  assert.deepEqual(verifier.verify({ rootfs: root, profile: 'bcm2712' }), { ok: true, profile: 'bcm2712' });
});

test('built-rootfs verifier rejects nested ROM packaging and path tamper', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'rom'));
  assert.throws(() => verifier.verify({ rootfs: root, profile: 'bcm2712' }), /nested.*rom/i);
  fs.rmSync(path.join(root, 'rom'), { recursive: true, force: true });
  fs.appendFileSync(path.join(root, 'etc/uci-defaults/97_osi_db_seed'), 'tamper');
  assert.throws(() => verifier.verify({ rootfs: root, profile: 'bcm2712' }), /hash mismatch/);
});

test('built-rootfs verifier rejects canonical-byte drift and symlink ancestors', () => {
  const root = fixture();
  const manifest = path.join(root, 'usr/share/osi-deploy/image-guard-manifest.json');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace('{', '{ '));
  assert.throws(() => verifier.verify({ rootfs: root, profile: 'bcm2712' }), /canonical JSON bytes/);

  const second = fixture();
  const libexec = path.join(second, 'usr/libexec');
  const moved = `${libexec}.real`;
  fs.renameSync(libexec, moved);
  fs.symlinkSync(moved, libexec);
  assert.throws(() => verifier.verify({ rootfs: second, profile: 'bcm2712' }), /symlink ancestor/);
});

test('built-rootfs verifier rejects missing or retargeted rc.d links and mode drift', () => {
  const missing = fixture();
  fs.unlinkSync(path.join(missing, 'etc/rc.d/S99node-red'));
  assert.throws(() => verifier.verify({ rootfs: missing, profile: 'bcm2712' }), /S99node-red/);

  const wrong = fixture();
  fs.unlinkSync(path.join(wrong, 'etc/rc.d/S90osi-db-integrity'));
  fs.symlinkSync('../init.d/osi-bootstrap', path.join(wrong, 'etc/rc.d/S90osi-db-integrity'));
  assert.throws(() => verifier.verify({ rootfs: wrong, profile: 'bcm2712' }), /target mismatch/);

  const modes = fixture();
  fs.chmodSync(path.join(modes, 'etc/uci-defaults/93_osi_deploy_guard_init'), 0o644);
  assert.throws(() => verifier.verify({ rootfs: modes, profile: 'bcm2712' }), /mode 755/);
});

test('built-rootfs verifier rejects manifest/provenance identity and special-mode drift', () => {
  const mismatch = fixture();
  const manifestPath = path.join(mismatch, 'usr/share/osi-deploy/image-guard-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.imageBuildId = '20260718-factory-bcm2712';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  assert.throws(() => verifier.verify({ rootfs: mismatch, profile: 'bcm2712' }), /imageBuildId|canonical/);

  const special = fixture();
  fs.chmodSync(path.join(special, 'usr/share/osi-deploy/factory-image-provenance.json'), 0o1644);
  assert.throws(() => verifier.verify({ rootfs: special, profile: 'bcm2712' }), /mode 644/);
});

test('built-rootfs verifier rejects duplicate command-line flags', () => {
  const root = fixture();
  const result = cp.spawnSync(process.execPath, [path.join(repo, 'scripts/verify-built-factory-image-provenance.js'), '--rootfs', root, '--rootfs', root, '--profile', 'bcm2712'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate flag/);
});
