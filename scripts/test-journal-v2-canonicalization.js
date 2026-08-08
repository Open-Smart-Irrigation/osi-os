#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/sync-schema/journal-v2-golden.json'), 'utf8'));
const canonicalizer = require(path.join(ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal-replication/canonicalization'));

for (const vector of vectors.vectors) {
  assert.equal(canonicalizer.canonicalize(vector.input), vector.canonical_json, vector.name);
  assert.equal(canonicalizer.sha256(vector.input), vector.sha256, `${vector.name} hash`);
}
console.log('PASS: journal v2 canonicalization vectors pass');
