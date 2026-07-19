'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const verifier = require('./verify-factory-image-provenance');

const root = path.resolve(__dirname, '..');

test('committed profile provenance validates both profiles and resident source copies', () => {
  const result = verifier.verify({ root });
  assert.deepEqual(result.profiles.sort(), ['bcm2709', 'bcm2712']);
});
test('verifier rejects an extra provenance field', () => {
  const file = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/osi-deploy/factory-image-provenance.json');
  const original = fs.readFileSync(file);
  try {
    const value = JSON.parse(original);
    value.extra = true;
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
    assert.throws(() => verifier.verify({ root, profile: 'bcm2712' }), /unknown field|canonical JSON bytes/);
  } finally { fs.writeFileSync(file, original); }
});

test('verifier rejects coordinated resident-copy drift', () => {
  const residents = ['conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-factory-image-provenance.js',
    'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-factory-image-provenance.js',
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-deployment-state.js',
    'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-deployment-state.js'];
  const originals = residents.map((file) => fs.readFileSync(path.join(root, file)));
  try {
    for (const file of residents) fs.appendFileSync(path.join(root, file), '\n// drift\n');
    assert.throws(() => verifier.verify({ root }), /hash mismatch|resident provenance library drift/);
  } finally {
    residents.forEach((file, index) => fs.writeFileSync(path.join(root, file), originals[index]));
  }
});

test('verifier rejects duplicate command-line flags', () => {
  const result = cp.spawnSync(process.execPath, [path.join(root, 'scripts/verify-factory-image-provenance.js'), '--root', root, '--root', root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate flag/);
});
