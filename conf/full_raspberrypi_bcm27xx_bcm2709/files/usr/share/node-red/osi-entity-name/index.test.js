'use strict';
// Co-located tests for osi-entity-name. The vector table below is the whole of
// section 4 of docs/superpowers/specs/2026-09-21-zone-device-rename-design.md;
// the TypeScript copy in the GUI and the Java class in osi-server carry the
// same sixteen rows.
const assert = require('node:assert/strict');
const test = require('node:test');

const entityName = require('./index');

const ACCEPTED = [
  ['North block', 'North block'],
  ['  North block \n', 'North block'],
  ['\u00a0Bloc nord\u00a0', 'Bloc nord'],
  ['\ufeffNorth', 'North'],
  ['\u2028North\u2029', 'North'],
  ['a'.repeat(100), 'a'.repeat(100)],
  ['\ud83c\udf31'.repeat(100), '\ud83c\udf31'.repeat(100)],
];

const REJECTED = [
  ['', 'name_empty'],
  ['   ', 'name_empty'],
  ['Row\t7', 'name_control_characters'],
  ['Row\u00007', 'name_control_characters'],
  ['A\u2028B', 'name_control_characters'],
  ['\u0085North', 'name_control_characters'],
  ['a'.repeat(101), 'name_too_long'],
  ['\ud83c', 'name_invalid_unicode'],
  ['\udf31x', 'name_invalid_unicode'],
];

test('the accepted vectors normalize to their stored form', () => {
  for (const [input, expected] of ACCEPTED) {
    assert.equal(
      entityName.normalizeEntityName(input),
      expected,
      'vector ' + JSON.stringify(input)
    );
  }
});

test('the rejected vectors fail with their reason code', () => {
  for (const [input, reason] of REJECTED) {
    assert.throws(
      () => entityName.normalizeEntityName(input),
      (error) => error.code === reason && error.statusCode === 400,
      'vector ' + JSON.stringify(input) + ' must fail with ' + reason
    );
  }
});

test('the limit counts code points, not UTF-16 units', () => {
  assert.equal(entityName.ENTITY_NAME_MAX, 100);
  const hundredSeedlings = '\ud83c\udf31'.repeat(100);
  assert.equal(hundredSeedlings.length, 200);
  assert.equal(Array.from(hundredSeedlings).length, 100);
  assert.equal(entityName.normalizeEntityName(hundredSeedlings), hundredSeedlings);
  assert.throws(
    () => entityName.normalizeEntityName('\ud83c\udf31'.repeat(101)),
    (error) => error.code === 'name_too_long'
  );
});

test('a missing name is name_empty and any other non-string is name_invalid_unicode', () => {
  for (const missing of [undefined, null]) {
    assert.throws(
      () => entityName.normalizeEntityName(missing),
      (error) => error.code === 'name_empty' && error.statusCode === 400,
      'a body without a name field must read as name_empty, not as broken Unicode'
    );
  }
  for (const wrongType of [42, {}, ['North'], true]) {
    assert.throws(
      () => entityName.normalizeEntityName(wrongType),
      (error) => error.code === 'name_invalid_unicode' && error.statusCode === 400,
      'vector ' + JSON.stringify(wrongType)
    );
  }
});

test('the surrogate scan does not depend on String.prototype.isWellFormed', () => {
  const source = require('node:fs').readFileSync(__dirname + '/index.js', 'utf8');
  // Call-shaped, so the comment in index.js that explains why the feature is
  // avoided does not trip its own guard.
  assert.equal(/\.(?:isWellFormed|toWellFormed)\s*\(/.test(source), false,
    'the gateway image ships a Node 20-era package; the scan must be hand-written');
});
