#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildCanonicalColumns, encodeHashInput, hashRow } = require('./lib/history-hash-v1');

const fixturePath = path.resolve(__dirname, '..', 'docs', 'sync', 'history-hash-v1-fixtures.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
let ok = true;

for (const row of fixture.fixtures) {
  const columns = buildCanonicalColumns(row.tableName, row.sourceRow);
  if (JSON.stringify(columns) !== JSON.stringify(row.expectedColumns)) {
    console.error(`${row.name}: canonical columns mismatch`);
    console.error(JSON.stringify(columns));
    ok = false;
  }
  console.log(`${row.name}.hashInput=${encodeHashInput(row)}`);
  const actual = hashRow(row);
  if (actual !== row.expectedSha256) {
    console.error(`${row.name}: expected ${row.expectedSha256}, got ${actual}`);
    ok = false;
  }
}

const fixtureSetSha256 = crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex');
console.log(`fixtureSetSha256=${fixtureSetSha256}`);
if (!ok) process.exit(1);
