'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadMigrations } = require('../migrations-loader');

function dirWith(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-mig-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), body);
  return d;
}

test('loads, orders, classifies and checksums migrations', () => {
  const d = dirWith({
    '0002__add_col.sql': '-- risk: additive\nALTER TABLE t ADD COLUMN x INTEGER;\n',
    '0001__baseline.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER);\n',
  });
  const m = loadMigrations(d);
  assert.equal(m.length, 2);
  assert.deepEqual(m.map((x) => x.version), [1, 2]);
  assert.equal(m[0].slug, 'baseline');
  assert.equal(m[1].risk, 'additive');
  assert.match(m[0].checksum, /^[0-9a-f]{64}$/);
});

test('rejects malformed filename', () => {
  const d = dirWith({ 'bad.sql': '-- risk: additive\n' });
  assert.throws(() => loadMigrations(d), /filename/i);
});

test('rejects duplicate version', () => {
  const d = dirWith({ '0001__a.sql': '-- risk: additive\n', '0001__b.sql': '-- risk: additive\n' });
  assert.throws(() => loadMigrations(d), /duplicate/i);
});

test('rejects missing risk header', () => {
  const d = dirWith({ '0001__a.sql': 'CREATE TABLE t (id INTEGER);\n' });
  assert.throws(() => loadMigrations(d), /risk/i);
});

test('checksums the raw migration bytes, not the decoded SQL text', () => {
  const raw = Buffer.concat([
    Buffer.from('-- risk: additive\n-- raw byte: '),
    Buffer.from([0xff]),
    Buffer.from('\nCREATE TABLE t (id INTEGER);\n'),
  ]);
  const d = dirWith({ '0001__raw.sql': raw });
  const [m] = loadMigrations(d);
  assert.equal(m.checksum, crypto.createHash('sha256').update(raw).digest('hex'));
});

test('rejects risk directives that are not in the file header', () => {
  const d = dirWith({
    '0001__late_risk.sql': 'CREATE TABLE t (id INTEGER);\n-- risk: additive\n',
  });
  assert.throws(() => loadMigrations(d), /risk/i);
});
