#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildCanonicalColumns, encodeHashInput, hashRow } = require('./lib/history-hash-v1');

const fixturePath = path.resolve(__dirname, '..', 'docs', 'sync', 'history-hash-v1-fixtures.json');
const updateExpected = process.argv.includes('--update');
let fixtureSource = fs.readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureSource);
let ok = true;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
    if (updateExpected) {
      const pattern = new RegExp(`("name"\\s*:\\s*${escapeRegExp(JSON.stringify(row.name))}[\\s\\S]*?"expectedSha256"\\s*:\\s*")[^"]+(")`);
      fixtureSource = fixtureSource.replace(pattern, `$1${actual}$2`);
      console.log(`${row.name}: updated expectedSha256=${actual}`);
    } else {
      console.error(`${row.name}: expected ${row.expectedSha256}, got ${actual}`);
      ok = false;
    }
  }
}

if (updateExpected) {
  fs.writeFileSync(fixturePath, fixtureSource);
}

const fixtureSetSha256 = crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex');
console.log(`fixtureSetSha256=${fixtureSetSha256}`);
if (!ok) process.exit(1);
