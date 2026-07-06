'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

const baseline = {
  version: 1,
  markers: ['CREATE TABLE', 'ALTER TABLE', 'writable_schema'],
  files: {
    'flows.json': {
      createTable: 1,
      alterTable: 0,
      writableSchema: 0,
      total: 1,
    },
    'deploy.sh': {
      createTable: 0,
      alterTable: 0,
      writableSchema: 0,
      total: 0,
    },
  },
  total: 1,
};

test('verify-no-stray-ddl accepts files at or below the committed baseline', () => {
  const { root, baselinePath } = writeFixture(
    {
      'flows.json': JSON.stringify([
        { type: 'function', func: 'db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)")' },
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
  assert.match(result.stdout, /OK \(total 1 <= baseline 1\)/);
});

test('verify-no-stray-ddl rejects an added DDL marker above the baseline', () => {
  const { root, baselinePath } = writeFixture(
    {
      'flows.json': JSON.stringify([
        {
          type: 'function',
          func:
            'db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)");\n' +
            'db.exec("ALTER TABLE t ADD COLUMN name TEXT");',
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
  assert.match(result.stderr, /flows\.json exceeds baseline/);
  assert.match(result.stderr, /alterTable: 1 > 0/);
  assert.match(result.stderr, /total: 2 > 1/);
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
