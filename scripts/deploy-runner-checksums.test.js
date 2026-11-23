'use strict';
// #762: the checksum list covers exactly the runner files deploy.sh fetches,
// and the committed manifest matches the tree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { FILES, MANIFEST, compute, render } = require('./deploy-runner-checksums');

const ROOT = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');

function functionBody(name) {
  const start = DEPLOY.indexOf(`\n${name}() {\n`);
  assert.ok(start !== -1, `deploy.sh defines ${name}`);
  return DEPLOY.slice(start, DEPLOY.indexOf('\n}\n', start + 1));
}

test('the list names every JavaScript file the two runner fetch functions request, and nothing else', () => {
  const bodies = functionBody('fetch_migration_runner') + functionBody('fetch_reconciliation_assets');
  const fetched = new Set([...bodies.matchAll(/[A-Za-z0-9_.-]+\.js\b/g)].map((m) => m[0]));
  assert.deepEqual([...fetched].sort(), FILES.map((f) => path.basename(f)).sort());
  for (const rel of FILES) assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
});

test('every fetched runner file is checked against the list before use', () => {
  const runner = functionBody('fetch_migration_runner');
  assert.match(runner, /fetch_required "Migration runner checksums" \\\n\s+"scripts\/deploy-runner-checksums\.json"/);
  assert.match(runner, /check_fetched_runner_checksums "\$TMP_DIR\/lib\/osi-migrate\/migration-manifest\.js" "\$TMP_DIR\/lib\/osi-migrate\/migrations-loader\.js"/);
  assert.match(runner, /check_fetched_runner_checksums "\$@" \|\| return 1/);
  assert.match(functionBody('fetch_reconciliation_assets'), /check_fetched_runner_checksums "\$TMP_DIR\/scripts\/reconcile-ledger-numbering\.js"/);
});

test('the committed manifest matches the tree (run --write after changing a runner file)', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, MANIFEST), 'utf8'), render(compute()));
  const run = spawnSync(process.execPath, [path.join(__dirname, 'deploy-runner-checksums.js')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
