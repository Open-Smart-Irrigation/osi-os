'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'verify-no-stray-ddl.js');

function writeFixture(files, baseline) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-no-stray-ddl-'));
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  const baselinePath = path.join(root, 'baseline.json');
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  return { root, baselinePath };
}

function runVerifier(args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function hashString(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function occurrence(marker, source, text, snippet) {
  return {
    marker,
    source,
    stringHash: hashString(text),
    snippet,
  };
}

const createTableText = 'db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)")';
const createTableOccurrence = occurrence(
  'createTable',
  '/0/func',
  createTableText,
  'CREATE TABLE IF NOT EXISTS t (id INTEGER)'
);

const baseline = {
  version: 1,
  markers: [
    'CREATE TABLE',
    'ALTER TABLE',
    'CREATE UNIQUE INDEX',
    'CREATE INDEX',
    'CREATE TRIGGER',
    'DROP TABLE',
    'DROP TRIGGER',
    'writable_schema',
  ],
  files: {
    'flows.json': {
      createTable: 1,
      alterTable: 0,
      createUniqueIndex: 0,
      createIndex: 0,
      createTrigger: 0,
      dropTable: 0,
      dropTrigger: 0,
      writableSchema: 0,
      total: 1,
      occurrences: [createTableOccurrence],
    },
    'deploy.sh': {
      createTable: 0,
      alterTable: 0,
      createUniqueIndex: 0,
      createIndex: 0,
      createTrigger: 0,
      dropTable: 0,
      dropTrigger: 0,
      writableSchema: 0,
      total: 0,
      occurrences: [],
    },
  },
  total: 1,
};

test('verify-no-stray-ddl accepts files that match the committed baseline exactly', () => {
  const { root, baselinePath } = writeFixture(
    {
      'flows.json': JSON.stringify([
        { type: 'function', func: createTableText },
      ]),
      'deploy.sh': '#!/bin/sh\ntrue\n',
    },
    baseline
  );

  const result = runVerifier([
    '--root',
    root,
    '--baseline',
    baselinePath,
    '--surface',
    'flows.json',
    '--surface',
    'deploy.sh',
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OK \(total 1 matches baseline 1\)/);
});

test('verify-no-stray-ddl rejects same-count DDL substitutions by occurrence identity', () => {
  const { root, baselinePath } = writeFixture(
    {
      'flows.json': JSON.stringify([
        { type: 'function', func: 'db.exec("CREATE TABLE IF NOT EXISTS renamed (id INTEGER)")' },
      ]),
      'deploy.sh': '#!/bin/sh\ntrue\n',
    },
    baseline
  );

  const result = runVerifier([
    '--root',
    root,
    '--baseline',
    baselinePath,
    '--surface',
    'flows.json',
    '--surface',
    'deploy.sh',
  ]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /flows\.json occurrence set differs from baseline/);
});

test('verify-no-stray-ddl rejects an added tracked DDL marker above the baseline', () => {
  const { root, baselinePath } = writeFixture(
    {
      'flows.json': JSON.stringify([
        {
          type: 'function',
          func:
            'db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)");\n' +
            'db.exec("CREATE INDEX idx_t_name ON t(name)");',
        },
      ]),
      'deploy.sh': '#!/bin/sh\ntrue\n',
    },
    baseline
  );

  const result = runVerifier([
    '--root',
    root,
    '--baseline',
    baselinePath,
    '--surface',
    'flows.json',
    '--surface',
    'deploy.sh',
  ]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /flows\.json differs from baseline/);
  assert.match(result.stderr, /createIndex: 1 != 0/);
  assert.match(result.stderr, /total: 2 > 1/);
});

test('verify-no-stray-ddl rejects actual counts below the baseline to avoid stale slack', () => {
  const { root, baselinePath } = writeFixture(
    {
      'flows.json': JSON.stringify([{ type: 'function', func: 'return msg;' }]),
      'deploy.sh': '#!/bin/sh\ntrue\n',
    },
    baseline
  );

  const result = runVerifier([
    '--root',
    root,
    '--baseline',
    baselinePath,
    '--surface',
    'flows.json',
    '--surface',
    'deploy.sh',
  ]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /flows\.json differs from baseline/);
  assert.match(result.stderr, /createTable: 0 != 1/);
  assert.match(result.stderr, /total: 0 < 1/);
});

test('verify-no-stray-ddl counts each flow string separately', () => {
  const splitKeywordBaseline = {
    ...baseline,
    files: {
      ...baseline.files,
      'flows.json': {
        createTable: 0,
        alterTable: 0,
        createUniqueIndex: 0,
        createIndex: 0,
        createTrigger: 0,
        dropTable: 0,
        dropTrigger: 0,
        writableSchema: 0,
        total: 0,
        occurrences: [],
      },
    },
    total: 0,
  };
  const { root, baselinePath } = writeFixture(
    {
      'flows.json': JSON.stringify(['CREATE', 'TABLE should not combine with the prior string']),
      'deploy.sh': '#!/bin/sh\ntrue\n',
    },
    splitKeywordBaseline
  );

  const result = runVerifier([
    '--root',
    root,
    '--baseline',
    baselinePath,
    '--surface',
    'flows.json',
    '--surface',
    'deploy.sh',
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OK \(total 0 matches baseline 0\)/);
});

test('verify-no-stray-ddl tracks DROP TRIGGER markers', () => {
  const zeroBaseline = {
    ...baseline,
    files: {
      ...baseline.files,
      'flows.json': {
        createTable: 0,
        alterTable: 0,
        createUniqueIndex: 0,
        createIndex: 0,
        createTrigger: 0,
        dropTable: 0,
        dropTrigger: 0,
        writableSchema: 0,
        total: 0,
        occurrences: [],
      },
    },
    total: 0,
  };
  const { root, baselinePath } = writeFixture(
    {
      'flows.json': JSON.stringify([{ type: 'function', func: 'db.exec("DROP TRIGGER old_trigger")' }]),
      'deploy.sh': '#!/bin/sh\ntrue\n',
    },
    zeroBaseline
  );

  const result = runVerifier([
    '--root',
    root,
    '--baseline',
    baselinePath,
    '--surface',
    'flows.json',
    '--surface',
    'deploy.sh',
  ]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /dropTrigger: 1 != 0/);
});

test('verify-no-stray-ddl accepts the committed shipped-surface baseline', () => {
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'scripts/verify-no-stray-ddl-baseline.json')),
    true,
    'scripts/verify-no-stray-ddl-baseline.json must be committed'
  );

  const result = runVerifier();

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /verify-no-stray-ddl: OK/);
});
