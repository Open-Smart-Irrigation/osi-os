'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gen = require('./generate-factory-image-provenance');
const codec = require('./lib/factory-image-provenance');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-image-gen-'));
  const profileRoot = path.join(root, 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files');
  const paths = {
    root,
    profileRoot,
    manifest: path.join(profileRoot, 'usr/share/osi-deploy/image-guard-manifest.json'),
    provenance: path.join(profileRoot, 'usr/share/osi-deploy/factory-image-provenance.json'),
  };
  for (const rel of ['etc/uci-defaults/93_osi_deploy_guard_init', 'etc/uci-defaults/97_osi_db_seed', 'usr/share/db/farming.db',
    'usr/libexec/osi-factory-database-seed.js', 'usr/libexec/osi-factory-database-seed-cli.js',
    'usr/libexec/osi-audit-command-ack-state.js', 'usr/libexec/osi-sync-protocol-capability-cli.js']) {
    const file = path.join(profileRoot, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rel, { mode: 0o600 });
  }
  const protocolHelper = path.join(profileRoot, 'usr/libexec/osi-sync-protocol-capability.js');
  fs.writeFileSync(protocolHelper, 'protocol-helper', { mode: 0o600 });
  fs.mkdirSync(path.dirname(paths.manifest), { recursive: true });
  return paths;
}

test('generator writes canonical manifest and provenance for a profile', () => {
  const f = fixture();
  const result = gen.generate({ root: f.root, profile: 'bcm2712', imageBuildId: 'build-1' });
  assert.equal(result.profile, 'bcm2712');
  assert.equal(JSON.parse(fs.readFileSync(f.provenance)).format, 2);
  assert.equal(JSON.parse(fs.readFileSync(f.manifest)).format, 1);
  assert.equal(gen.check({ root: f.root, profile: 'bcm2712' }).ok, true);
});

test('generator check fails after a bound source changes', () => {
  const f = fixture();
  gen.generate({ root: f.root, profile: 'bcm2712', imageBuildId: 'build-1' });
  fs.appendFileSync(path.join(f.profileRoot, 'usr/libexec/osi-factory-database-seed-cli.js'), 'tamper');
  assert.throws(() => gen.check({ root: f.root, profile: 'bcm2712' }), /hash mismatch/);
});
