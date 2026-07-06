'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'verify-no-stray-ddl.js');

function runVerifier(args = [], options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
  });
}

// ---------------------------------------------------------------------------
// Scratch git repo helper: creates a real git repo with a "base" commit and
// then lets the caller mutate the working tree to simulate HEAD (uncommitted
// changes are fine — the verifier reads HEAD's surface files straight off
// disk via --root, and reads the base via `git show <ref>:<path>` via
// --git-root). This lets the base-ref tests run without depending on the
// live origin/main state.
// ---------------------------------------------------------------------------

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

function initScratchRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-no-stray-ddl-git-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFiles(dir, files);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

function writeFiles(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
}

const FLOWS_SURFACE = 'flows.json';
const DEPLOY_SURFACE = 'deploy.sh';
const SURFACE_ARGS = ['--surface', FLOWS_SURFACE, '--surface', DEPLOY_SURFACE];

function baseFixtureFiles() {
  return {
    [FLOWS_SURFACE]: JSON.stringify([
      { type: 'function', func: 'db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)")' },
      { type: 'function', func: 'return msg;' },
    ]),
    [DEPLOY_SURFACE]: '#!/bin/sh\ntrue\n',
  };
}

function runAgainstScratchRepo(dir, extraArgs = []) {
  return runVerifier([
    '--root',
    dir,
    '--git-root',
    dir,
    '--base-ref',
    'HEAD',
    '--baseline',
    path.join(dir, 'baseline.json'),
    ...SURFACE_ARGS,
    ...extraArgs,
  ]);
}

test('verify-no-stray-ddl: base-anchored PASS when HEAD counts equal base counts', () => {
  const dir = initScratchRepo(baseFixtureFiles());
  execFileSync(process.execPath, [
    script,
    '--root',
    dir,
    '--git-root',
    dir,
    '--base-ref',
    'HEAD',
    '--baseline',
    path.join(dir, 'baseline.json'),
    ...SURFACE_ARGS,
    '--write-baseline',
  ]);

  const result = runAgainstScratchRepo(dir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OK \(HEAD total 1 <= HEAD total 1/);
});

test('verify-no-stray-ddl: base-anchored FAIL when HEAD adds DDL not present in base', () => {
  const dir = initScratchRepo(baseFixtureFiles());
  execFileSync(process.execPath, [
    script,
    '--root',
    dir,
    '--git-root',
    dir,
    '--base-ref',
    'HEAD',
    '--baseline',
    path.join(dir, 'baseline.json'),
    ...SURFACE_ARGS,
    '--write-baseline',
  ]);

  // Mutate the working tree (uncommitted) to add a new CREATE TABLE not in base HEAD.
  writeFiles(dir, {
    [FLOWS_SURFACE]: JSON.stringify([
      { type: 'function', func: 'db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)")' },
      { type: 'function', func: 'db.exec("CREATE TABLE IF NOT EXISTS stray (id INTEGER)")' },
    ]),
  });

  const result = runAgainstScratchRepo(dir);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /createTable increased vs HEAD \(2 > 1\)/);
});

test('verify-no-stray-ddl: self-certification is blocked — injecting DDL and regenerating the committed baseline still FAILS', () => {
  const dir = initScratchRepo(baseFixtureFiles());
  const baselinePath = path.join(dir, 'baseline.json');
  execFileSync(process.execPath, [
    script,
    '--root',
    dir,
    '--git-root',
    dir,
    '--base-ref',
    'HEAD',
    '--baseline',
    baselinePath,
    ...SURFACE_ARGS,
    '--write-baseline',
  ]);

  // Simulate a PR that adds DDL AND regenerates the committed baseline in
  // the same commit (working tree), attempting to self-certify.
  writeFiles(dir, {
    [FLOWS_SURFACE]: JSON.stringify([
      { type: 'function', func: 'db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)")' },
      { type: 'function', func: 'db.exec("CREATE TABLE IF NOT EXISTS stray (id INTEGER)")' },
    ]),
  });
  execFileSync(process.execPath, [
    script,
    '--root',
    dir,
    '--git-root',
    dir,
    '--base-ref',
    'HEAD',
    '--baseline',
    baselinePath,
    ...SURFACE_ARGS,
    '--write-baseline',
  ]);

  // The regenerated baseline now agrees with HEAD's inflated counts...
  const regenerated = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  assert.equal(regenerated.files[FLOWS_SURFACE].createTable, 2);

  // ...but enforcement is vs the git ref (HEAD, i.e. the committed base
  // commit before this uncommitted mutation), not the committed baseline
  // file, so it must still fail.
  const result = runAgainstScratchRepo(dir);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /createTable increased vs HEAD \(2 > 1\)/);
});

test('verify-no-stray-ddl: order-insensitive — reordering nodes and unrelated deploy.sh edits do not trip the guard', () => {
  const dir = initScratchRepo(baseFixtureFiles());
  execFileSync(process.execPath, [
    script,
    '--root',
    dir,
    '--git-root',
    dir,
    '--base-ref',
    'HEAD',
    '--baseline',
    path.join(dir, 'baseline.json'),
    ...SURFACE_ARGS,
    '--write-baseline',
  ]);

  // Reorder the flows.json nodes and add an unrelated deploy.sh comment; no
  // net-new DDL.
  writeFiles(dir, {
    [FLOWS_SURFACE]: JSON.stringify([
      { type: 'function', func: 'return msg;' },
      { type: 'function', func: 'db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)")' },
    ]),
    [DEPLOY_SURFACE]: '#!/bin/sh\n# unrelated comment about retries\ntrue\n',
  });

  const result = runAgainstScratchRepo(dir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('verify-no-stray-ddl: fails closed when --base-ref is unreachable', () => {
  const dir = initScratchRepo(baseFixtureFiles());
  execFileSync(process.execPath, [
    script,
    '--root',
    dir,
    '--git-root',
    dir,
    '--base-ref',
    'HEAD',
    '--baseline',
    path.join(dir, 'baseline.json'),
    ...SURFACE_ARGS,
    '--write-baseline',
  ]);

  const result = runVerifier([
    '--root',
    dir,
    '--git-root',
    dir,
    '--base-ref',
    'refs/remotes/origin/does-not-exist',
    '--baseline',
    path.join(dir, 'baseline.json'),
    ...SURFACE_ARGS,
  ]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /base ref unusable, failing closed/);
});

const EVASION_FORMS = [
  ['double-spaced CREATE  TABLE', 'db.exec("CREATE  TABLE IF NOT EXISTS t (id INTEGER)")'],
  ['lowercase create table', 'db.exec("create table if not exists t (id integer)")'],
  ['IF NOT EXISTS variant', 'db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)")'],
  ['newline-split ALTER\\n TABLE', 'db.exec("ALTER\n TABLE t ADD COLUMN x TEXT")'],
  ['PRAGMA writable_schema', 'db.exec("PRAGMA writable_schema=1")'],
];

for (const [label, snippet] of EVASION_FORMS) {
  test(`verify-no-stray-ddl: evasion form still caught vs base — ${label}`, () => {
    const dir = initScratchRepo(baseFixtureFiles());
    execFileSync(process.execPath, [
      script,
      '--root',
      dir,
      '--git-root',
      dir,
      '--base-ref',
      'HEAD',
      '--baseline',
      path.join(dir, 'baseline.json'),
      ...SURFACE_ARGS,
      '--write-baseline',
    ]);

    writeFiles(dir, {
      [FLOWS_SURFACE]: JSON.stringify([
        { type: 'function', func: 'db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)")' },
        { type: 'function', func: snippet },
      ]),
    });

    const result = runAgainstScratchRepo(dir);

    assert.notEqual(result.status, 0, result.stdout);
  });
}

test('verify-no-stray-ddl: --write-baseline produces a baseline that matches a fresh recount', () => {
  const dir = initScratchRepo(baseFixtureFiles());
  const baselinePath = path.join(dir, 'baseline.json');

  const writeResult = runVerifier([
    '--root',
    dir,
    '--git-root',
    dir,
    '--base-ref',
    'HEAD',
    '--baseline',
    baselinePath,
    ...SURFACE_ARGS,
    '--write-baseline',
  ]);
  assert.equal(writeResult.status, 0, writeResult.stderr || writeResult.stdout);

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  assert.equal(baseline.files[FLOWS_SURFACE].createTable, 1);
  assert.equal(baseline.files[FLOWS_SURFACE].total, 1);
  assert.equal(baseline.files[DEPLOY_SURFACE].total, 0);
  assert.equal(baseline.total, 1);

  // A normal run right after --write-baseline must pass both gates.
  const verifyResult = runAgainstScratchRepo(dir);
  assert.equal(verifyResult.status, 0, verifyResult.stderr || verifyResult.stdout);
});

test('verify-no-stray-ddl: rejects a committed baseline that is stale vs HEAD even when base-ref enforcement passes', () => {
  const dir = initScratchRepo(baseFixtureFiles());
  const baselinePath = path.join(dir, 'baseline.json');
  execFileSync(process.execPath, [
    script,
    '--root',
    dir,
    '--git-root',
    dir,
    '--base-ref',
    'HEAD',
    '--baseline',
    baselinePath,
    ...SURFACE_ARGS,
    '--write-baseline',
  ]);

  // Hand-edit the committed baseline to no longer match HEAD (simulates
  // baseline drift without regenerating it), while HEAD/base stay identical
  // so gate 1 (the real enforcement) passes.
  const stale = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  stale.files[FLOWS_SURFACE].createTable = 0;
  stale.files[FLOWS_SURFACE].total = 0;
  stale.total = 0;
  fs.writeFileSync(baselinePath, JSON.stringify(stale, null, 2));

  const result = runAgainstScratchRepo(dir);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /committed baseline is stale/);
});

test('verify-no-stray-ddl accepts the committed shipped-surface baseline against origin/main', () => {
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'scripts/verify-no-stray-ddl-baseline.json')),
    true,
    'scripts/verify-no-stray-ddl-baseline.json must be committed'
  );

  const result = runVerifier();

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /verify-no-stray-ddl: OK/);
});
