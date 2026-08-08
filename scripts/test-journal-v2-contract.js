#!/usr/bin/env node
'use strict';

// V2 acceptance is intentionally separate from the V1 event/command contract.
// This guard validates the closed schema and the semantic rules Draft-07 cannot express.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs/contracts/sync-schema/journal-v2.schema.json'), 'utf8'
));
const golden = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs/contracts/sync-schema/journal-v2-golden.json'), 'utf8'
));
const canonicalizer = require(path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal-replication/canonicalization'
));
const { contractValidationErrors, schemaStructureErrors } = require('./test-contract-schemas');

function schemaErrors(value) {
  return contractValidationErrors(schema, value, schema);
}

function referencedDefinition(ref) {
  const prefix = '#/definitions/';
  assert.ok(ref.startsWith(prefix), `expected a local definition ref, got ${ref}`);
  return schema.definitions[ref.slice(prefix.length)];
}

function assertClosedVariants(definitionName, expectedCount) {
  const union = schema.definitions[definitionName];
  assert.equal(union.oneOf.length, expectedCount, `${definitionName} variant count`);
  for (const variantRef of union.oneOf) {
    const variant = referencedDefinition(variantRef.$ref);
    assert.equal(variant.type, 'object', `${variantRef.$ref} must be an object`);
    assert.equal(variant.additionalProperties, false, `${variantRef.$ref} must be closed`);
  }
}

assert.deepEqual(schemaStructureErrors(schema), [], 'journal-v2.schema.json must be valid Draft-07');
assertClosedVariants('mutationEnvelope', 7);
assertClosedVariants('replicationEnvelope', 7);
assertClosedVariants('mutationResult', 4);
for (const name of [
  'v2Entry', 'entryValue', 'farmProduct', 'customVocabulary', 'vocabMapping',
  'plotSnapshot', 'plotSettings', 'cutoverBarrierReceipt', 'attachmentDescriptor',
  'cropCycleProjection', 'cropCyclePlot', 'authorityState',
]) {
  assert.equal(schema.definitions[name].additionalProperties, false, `${name} must be closed`);
}

assert.equal(golden.mutation_vectors.length, 7, 'one full positive vector per mutation variant');
for (const vector of golden.mutation_vectors) {
  assert.deepEqual(schemaErrors(vector.input), [], `${vector.name} must satisfy the schema`);
  assert.doesNotThrow(() => canonicalizer.validateMutation(vector.input), `${vector.name} semantic validation`);
  assert.equal(canonicalizer.hashMutation(vector.input), vector.payload_sha256, `${vector.name} hash`);
}

assert.equal(golden.replication_vectors.length, 7, 'one full positive vector per replication variant');
for (const vector of golden.replication_vectors) {
  assert.deepEqual(schemaErrors(vector.input), [], `${vector.name} must satisfy the schema`);
  assert.doesNotThrow(() => canonicalizer.validateReplication(vector.input), `${vector.name} semantic validation`);
  assert.equal(canonicalizer.hashReplication(vector.input), vector.payload_sha256, `${vector.name} hash`);
}
assert.doesNotThrow(
  () => canonicalizer.validateReplicationBatch(golden.replication_vectors.map((vector) => vector.input)),
  'the positive replication feed must be numerically ascending'
);

assert.equal(golden.result_vectors.length, 4, 'one positive vector per typed result variant');
for (const vector of golden.result_vectors) {
  assert.deepEqual(schemaErrors(vector.input), [], `${vector.name} must satisfy the schema`);
}

assert.ok(golden.rejection_vectors.length >= 12, 'shared rejection coverage must be substantial');
for (const vector of golden.rejection_vectors) {
  if (vector.target !== 'replication_batch') {
    const errors = schemaErrors(vector.input);
    if (vector.layer === 'schema') {
      assert.notDeepEqual(errors, [], `${vector.name} must fail structural validation`);
    } else {
      assert.deepEqual(errors, [], `${vector.name} must isolate semantic validation`);
    }
  }
  const validate = vector.target === 'mutation'
    ? () => canonicalizer.validateMutation(vector.input)
    : vector.target === 'replication'
      ? () => canonicalizer.validateReplication(vector.input)
      : () => canonicalizer.validateReplicationBatch(vector.input);
  assert.throws(validate, new RegExp(vector.error), vector.name);
}

const v1 = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs/contracts/sync-schema/events.schema.json'), 'utf8'
));
assert.equal(v1.properties.op.enum.includes('ENTRY_CREATE'), false, 'V1 operations must not accept V2 mutations');
assert.notEqual(
  contractValidationErrors(v1, golden.mutation_vectors[0].input, v1).length,
  0,
  'V1 event envelope must reject a V2 mutation'
);
assert.equal(schema.title, 'Field Journal V2 Replication Contract', 'schema identity must be stable');
console.log('PASS: journal v2 contract checks pass');
