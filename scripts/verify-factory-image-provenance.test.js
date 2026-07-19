'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
    assert.throws(() => verifier.verify({ root, profile: 'bcm2712' }), /unknown field/);
  } finally { fs.writeFileSync(file, original); }
});
