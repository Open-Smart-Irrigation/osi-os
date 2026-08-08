#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const golden = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs/contracts/sync-schema/journal-v2-golden.json'), 'utf8'
));
const canonicalizer = require(path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal-replication/canonicalization'
));

for (const vector of golden.vectors) {
  assert.equal(canonicalizer.canonicalize(vector.input), vector.canonical_json, vector.name);
  assert.equal(canonicalizer.sha256(vector.input), vector.sha256, `${vector.name} hash`);
}

for (const [kind, hash] of [
  ['mutation', canonicalizer.hashMutation],
  ['replication', canonicalizer.hashReplication],
]) {
  const vectors = golden[`${kind}_vectors`];
  assert.ok(Array.isArray(vectors) && vectors.length > 0, `${kind} envelope vectors must exist`);
  for (const vector of vectors) {
    const { payload_sha256: _payloadSha256, ...hashInput } = vector.input;
    const declaredHashInput = kind === 'mutation' ? hashInput : vector.input.payload;
    assert.equal(canonicalizer.canonicalize(declaredHashInput), vector.canonical_hash_input, `${vector.name} bytes`);
    assert.equal(hash(vector.input), vector.payload_sha256, `${vector.name} hash`);
  }
}

for (const vector of golden.rejection_vectors) {
  const validate = vector.target === 'mutation'
    ? () => canonicalizer.validateMutation(vector.input)
    : vector.target === 'replication'
      ? () => canonicalizer.validateReplication(vector.input)
      : () => canonicalizer.validateReplicationBatch(vector.input);
  assert.throws(validate, new RegExp(vector.error), vector.name);
}

console.log('PASS: journal v2 canonicalization vectors pass');
