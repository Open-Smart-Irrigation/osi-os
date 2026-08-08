'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const canonicalizer = require('./canonicalization');

test('journal v2 canonicalizer produces stable bytes and hashes', () => {
  const value = { z: 1, a: 'D4FE4B8F-2C58-4D1C-A8C3-9DCE37E6EC90' };
  assert.equal(canonicalizer.canonicalize(value), '{"a":"d4fe4b8f-2c58-4d1c-a8c3-9dce37e6ec90","z":1}');
  assert.equal(canonicalizer.sha256(value), '87acb60f51e4e45e41f1db1b6a9dcf44c136f7e1deab296396585b30f8c4ee60');
});
