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
    'usr/libexec/osi-deployment-state-cli.js', 'usr/libexec/osi-audit-command-ack-state.js',
    'usr/libexec/osi-sync-protocol-capability-cli.js', 'usr/libexec/osi-factory-image-provenance.js',
    'usr/libexec/osi-factory-image-provenance-cli.js']) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, rel), target);
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
