'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'verify-migrations.js');

function sha256(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function tempOrderedDir(files, manifestEntries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-migrations-'));
  const dir = path.join(root, 'ordered');
  fs.mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  fs.writeFileSync(
    path.join(dir, 'CHECKSUMS.json'),
    `${JSON.stringify(manifestEntries, null, 2)}\n`
  );
  return dir;
}

function writeOrderedDir(rootName, files, manifestEntries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), rootName));
  const dir = path.join(root, 'ordered');
  fs.mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  if (manifestEntries) {
    fs.writeFileSync(
      path.join(dir, 'CHECKSUMS.json'),
      `${JSON.stringify(manifestEntries, null, 2)}\n`
    );
  }
  return dir;
}

function runVerifier(args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('verify-migrations accepts migrations whose checksums match the manifest', () => {
  const migration = '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n';
  const dir = tempOrderedDir(
    { '0001__baseline.sql': migration },
    { '0001__baseline.sql': sha256(migration) }
  );

  const result = runVerifier(['--migrations-dir', dir]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OK \(1 migrations, checksum manifest OK\)/);
});

test('verify-migrations rejects an edited migration whose checksum differs from the manifest', () => {
  const original = '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n';
  const edited = '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);\n';
  const dir = tempOrderedDir(
    { '0001__baseline.sql': edited },
    { '0001__baseline.sql': sha256(original) }
  );

  const result = runVerifier(['--migrations-dir', dir]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /checksum mismatch for 0001__baseline\.sql/);
});

test('verify-migrations rejects migration files missing from the checksum manifest', () => {
  const baseline = '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n';
  const later = '-- risk: additive\nALTER TABLE t ADD COLUMN name TEXT;\n';
  const dir = tempOrderedDir(
    {
      '0001__baseline.sql': baseline,
      '0002__later.sql': later,
    },
    { '0001__baseline.sql': sha256(baseline) }
  );

  const result = runVerifier(['--migrations-dir', dir]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /missing checksum manifest entry for 0002__later\.sql/);
});

test('verify-migrations rejects checksum manifest entries without migration files', () => {
  const baseline = '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n';
  const dir = tempOrderedDir(
    { '0001__baseline.sql': baseline },
    {
      '0001__baseline.sql': sha256(baseline),
      '0002__stale.sql': sha256('-- risk: additive\nALTER TABLE t ADD COLUMN stale TEXT;\n'),
    }
  );

  const result = runVerifier(['--migrations-dir', dir]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /checksum manifest entry has no migration file: 0002__stale\.sql/);
});

test('verify-migrations rejects edits to base migrations even when the manifest is updated', () => {
  const original = '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n';
  const edited = '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);\n';
  const baseDir = writeOrderedDir(
    'verify-migrations-base-',
    { '0001__baseline.sql': original },
    { '0001__baseline.sql': sha256(original) }
  );
  const dir = writeOrderedDir(
    'verify-migrations-head-',
    { '0001__baseline.sql': edited },
    { '0001__baseline.sql': sha256(edited) }
  );

  const result = runVerifier(['--migrations-dir', dir, '--base-migrations-dir', baseDir]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /base migration changed: 0001__baseline\.sql/);
});

test('verify-migrations allows a next-version migration and manifest entry beyond the base', () => {
  const baseline = '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n';
  const later = '-- risk: additive\nALTER TABLE t ADD COLUMN name TEXT;\n';
  const baseDir = writeOrderedDir(
    'verify-migrations-base-',
    { '0001__baseline.sql': baseline },
    { '0001__baseline.sql': sha256(baseline) }
  );
  const dir = writeOrderedDir(
    'verify-migrations-head-',
    {
      '0001__baseline.sql': baseline,
      '0002__later.sql': later,
    },
    {
      '0001__baseline.sql': sha256(baseline),
      '0002__later.sql': sha256(later),
    }
  );

  const result = runVerifier(['--migrations-dir', dir, '--base-migrations-dir', baseDir]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /base immutability OK/);
});

test('verify-migrations accepts the committed ordered migration checksum manifest', () => {
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'database/migrations/ordered/CHECKSUMS.json')),
    true,
    'database/migrations/ordered/CHECKSUMS.json must be committed'
  );

  const result = runVerifier();

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /checksum manifest OK/);
});
