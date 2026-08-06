#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const exporter = require('./export-journal-catalog');

const artifact = exporter.buildCatalogArtifact();

// The artifact on disk is exactly what the exporter would write today.
assert.equal(
  fs.readFileSync(exporter.OUT_PATH, 'utf8'),
  exporter.artifactText(artifact),
  'docs/contracts/journal-catalog/journal-catalog.json is stale; run node scripts/export-journal-catalog.js'
);

// Version/hash come from the shipped DB's journal_catalog_state, so the cloud
// can compare them against what a gateway advertises at bootstrap.
assert.equal(artifact.catalog_version, 10, 'shipped catalog must be v10');
assert.match(artifact.catalog_hash, /^[0-9a-f]{64}$/);

// v10 markers: the full_record@10 template carries the three operation maps.
const fullRecord10 = artifact.templates.find(
  (row) => row.code === 'full_record' && row.version === 10
);
assert.ok(fullRecord10, 'full_record@10 must be present');
for (const key of [
  'operation_fields_by_operation',
  'operation_requirements',
  'operation_product_kinds',
]) {
  assert.equal(
    typeof fullRecord10.definition[key],
    'object',
    `full_record@10 must carry ${key}`
  );
}
const operationSection = (fullRecord10.definition.sections || [])
  .find((section) => section.code === 'operation');
assert.equal(operationSection && operationSection.scoped_by_activity, true,
  'the operation section must stay scoped_by_activity');

// No principal-scoped rows may leak into a shared artifact.
for (const row of artifact.vocab) {
  assert.equal(row.scope, 'core', `vocab ${row.code} is not core-scoped`);
  assert.equal(row.owner_user_uuid, null, `vocab ${row.code} carries an owner`);
}
for (const row of artifact.products) {
  assert.equal(row.scope, 'core', `product ${row.product_uuid} is not core-scoped`);
}

// Every term is labelled, so catalogLabel() never has to fall back to a raw code.
for (const row of artifact.vocab) {
  assert.ok(row.labels && typeof row.labels.en === 'string' && row.labels.en.length > 0,
    `vocab ${row.code} has no en label`);
}

// Ordering must match api.js catalogDto's JS comparators, NOT SQLite's BINARY
// collation. They genuinely disagree: BINARY sorts 'unit.m2_area' before
// 'unit.m_per_s' ('2' = 0x32 < '_' = 0x5F) while localeCompare does the
// reverse. Without this the artifact is the right rows in the wrong order and
// the "same bytes a gateway would answer" claim is false (reading 1, L1).
assert.deepEqual(
  artifact.vocab.map((row) => row.code),
  [...artifact.vocab].sort((a, b) => a.code.localeCompare(b.code)).map((row) => row.code),
  'vocab must be ordered by code.localeCompare, matching api.js catalogDto'
);
for (const key of ['templates', 'layouts']) {
  assert.deepEqual(
    artifact[key].map((row) => `${row.code}@${row.version}`),
    [...artifact[key]]
      .sort((a, b) => a.code.localeCompare(b.code) || a.version - b.version)
      .map((row) => `${row.code}@${row.version}`),
    `${key} must be ordered by code.localeCompare then version`
  );
}
assert.deepEqual(
  artifact.products.map((row) => row.product_uuid),
  [...artifact.products]
    .sort((a, b) => a.product_uuid.localeCompare(b.product_uuid))
    .map((row) => row.product_uuid),
  'products must be ordered by product_uuid.localeCompare'
);

// Key order must match a live gateway's two-stage catalogDto shape (S3 T2b):
// catalog.js's parse*Row appends its derived keys after the raw DB columns,
// and api.js's catalogDto only overwrites their values in place — it never
// re-inserts them — so a gateway response and this artifact must list every
// row's keys in the identical order, not just the same key set, for the
// README's "same order" claim to be true. Pin the full array (not just the
// tail) so a future DB column reorder cannot slip through unnoticed, and
// check every row (not just row 0) so a heterogeneous row cannot sneak in.
const EXPECTED_VOCAB_KEYS = [
  'code', 'kind', 'parent_code', 'value_type', 'quantity_kind', 'basis',
  'default_unit_code', 'icon_key', 'agrovoc_uri', 'icasa_code', 'adapt_code',
  'scope', 'owner_user_uuid', 'gateway_device_eui', 'custom_field_uuid',
  'active', 'sort_order', 'sync_version', 'created_at', 'deleted_at',
  'labels', 'constraints', 'catalog_errors',
];
const EXPECTED_DEFINITION_KEYS = [
  'code', 'version', 'active', 'labels', 'definition', 'catalog_errors',
];
const EXPECTED_PRODUCT_KEYS = [
  'product_uuid', 'scope', 'owner_user_uuid', 'gateway_device_eui', 'name',
  'kind', 'active', 'sync_version', 'created_at', 'deleted_at',
  'composition', 'catalog_errors',
];
const EXPECTED_MAPPING_KEYS = [
  'term_code', 'scheme_uri', 'scheme_version', 'mapping_role', 'external_id',
  'external_parent_id', 'mapping_relation', 'source_uri', 'active',
];

function assertUniformKeyOrder(rows, expectedKeys, label) {
  assert.ok(rows.length > 0, `${label}: no rows to check`);
  rows.forEach((row, index) => {
    assert.deepStrictEqual(
      Object.keys(row),
      expectedKeys,
      `${label}[${index}] key order does not match the gateway's catalogDto shape`
    );
  });
}

assertUniformKeyOrder(artifact.vocab, EXPECTED_VOCAB_KEYS, 'vocab');
assertUniformKeyOrder(artifact.templates, EXPECTED_DEFINITION_KEYS, 'templates');
assertUniformKeyOrder(artifact.layouts, EXPECTED_DEFINITION_KEYS, 'layouts');
assertUniformKeyOrder(artifact.products, EXPECTED_PRODUCT_KEYS, 'products');
assertUniformKeyOrder(artifact.mappings, EXPECTED_MAPPING_KEYS, 'mappings');

// catalog_errors is DERIVED, not hardcoded: a row whose *_json column does not
// parse to a plain object records the offending column name, exactly as
// catalog.js safeJson does. The shipped DB is clean, so every list is empty —
// but a future malformed row must not be exported as clean (L2).
for (const row of [...artifact.vocab, ...artifact.templates,
                   ...artifact.layouts, ...artifact.products]) {
  assert.ok(Array.isArray(row.catalog_errors),
    `${row.code || row.product_uuid} has no catalog_errors array`);
  assert.deepEqual(row.catalog_errors, [],
    `${row.code || row.product_uuid} carries catalog errors: ` +
    `${row.catalog_errors.join(',')} — the shipped catalog must be clean`);
}
// And the derivation actually fires: a hand-made malformed row is flagged.
assert.deepEqual(
  exporter.vocabDto({ code: 'x', scope: 'core', labels_json: '{not json',
                      constraints_json: null }).catalog_errors,
  ['labels_json']
);

// The DTO must not carry the raw *_json columns or mapping row ids.
for (const row of [...artifact.vocab, ...artifact.templates, ...artifact.layouts]) {
  assert.equal('labels_json' in row, false);
}
for (const row of artifact.mappings) {
  assert.equal('id' in row, false);
}

console.log(
  `test-export-journal-catalog: OK (v${artifact.catalog_version}, ` +
  `${artifact.vocab.length} vocab, ${artifact.templates.length} templates, ` +
  `${artifact.layouts.length} layouts, ${artifact.products.length} products)`
);
