'use strict';

const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { after } = test;

const REPO = path.resolve(__dirname, '..');
const TARGET = path.join(REPO, 'scripts/reconcile-ledger-numbering.test.js');
const HELPER = path.join(REPO, 'scripts/helpers/test-owned-scratch.js');
const SELECTED_PATTERN = 'buildMainIndex builds exact';
const SELECTED_TEST = 'buildMainIndex builds exact + header-stripped indices keyed correctly';
const SENTINEL = Buffer.from('private TMPDIR sentinel\n', 'utf8');
const parents = new Set();

function createPrivateParent(fixtureName = null) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-cleanup-oracle-'));
  const record = {
    parent,
    sentinel: path.join(parent, 'sentinel.bin'),
    fixture: fixtureName ? path.join(parent, fixtureName) : null,
    roots: new Set(),
  };
  fs.writeFileSync(record.sentinel, SENTINEL);
  parents.add(record);
  return record;
}

function discoverOwnedRoots(record) {
  const names = fs.readdirSync(record.parent);
  const allowed = new Set(['sentinel.bin']);
  if (record.fixture) allowed.add(path.basename(record.fixture));
  const roots = [];
  for (const name of names) {
    if (name.startsWith('reconcile-test-')) {
      roots.push(name);
      record.roots.add(name);
    } else if (!allowed.has(name)) {
      assert.fail(`unexpected entry in private TMPDIR: ${path.join(record.parent, name)}`);
    }
  }
  return roots;
}

function cleanupParent(record) {
  const names = fs.readdirSync(record.parent);
  const fixtureName = record.fixture ? path.basename(record.fixture) : null;
  if (!names.includes('sentinel.bin') || (fixtureName && !names.includes(fixtureName))) {
    throw new Error(`preserving private TMPDIR with a missing owned sentinel or fixture: ${record.parent}`);
  }
  const allowed = new Set(['sentinel.bin', ...record.roots]);
  if (fixtureName) allowed.add(fixtureName);
  const unexpected = names.filter((name) => !allowed.has(name));
  if (unexpected.length) {
    throw new Error(`preserving private TMPDIR with unexpected entries: ${unexpected.join(', ')}`);
  }

  for (const name of record.roots) {
    fs.rmSync(path.join(record.parent, name), { recursive: true, force: true });
  }
  if (record.fixture && fs.existsSync(record.fixture)) fs.unlinkSync(record.fixture);
  if (fs.existsSync(record.sentinel)) fs.unlinkSync(record.sentinel);
  fs.rmdirSync(record.parent);
  parents.delete(record);
}

after(() => {
  const failures = [];
  for (const record of parents) {
    try {
      cleanupParent(record);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'oracle private TMPDIR cleanup failed');
});

function runChild(args, tmpdir, timeout, maxBuffer) {
  const env = { ...process.env, TMPDIR: tmpdir };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    env,
    maxBuffer,
    timeout,
  });
  assert.equal(child.error, undefined, `child launch/timeout/output limit: ${child.error || ''}`);
  assert.equal(child.signal, null, `child ended by signal ${child.signal}`);
  return child;
}

test('selected reconcile test leaves the private TMPDIR clean and preserves its sentinel', () => {
  const record = createPrivateParent();
  const child = runChild(
    ['--test', `--test-name-pattern=${SELECTED_PATTERN}`, TARGET],
    record.parent,
    120_000,
    2 * 1024 * 1024,
  );

  assert.equal(child.status, 0, `selected child failed:\n${child.stdout}\n${child.stderr}`);
  assert.ok(
    child.stdout.includes(SELECTED_TEST) || child.stderr.includes(SELECTED_TEST),
    `selected case was not reported; child output:\n${child.stdout}\n${child.stderr}`,
  );
  assert.match(`${child.stdout}\n${child.stderr}`, /(?:#|ℹ) pass 1\b/, 'selected child did not report exactly one passing test');

  const roots = discoverOwnedRoots(record);
  assert.deepEqual(fs.readFileSync(record.sentinel), SENTINEL, 'selected child changed the sentinel');
  assert.deepEqual(roots, [], `selected test left owned roots: ${roots.join(', ')}`);
  cleanupParent(record);
});

test('test-owned scratch cleanup runs after an assertion failure and preserves the sentinel', () => {
  const record = createPrivateParent('assertion-failure.cjs');
  const helperImport = JSON.stringify(HELPER);
  fs.writeFileSync(record.fixture, `
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createTestScratch } = require(${helperImport});
const scratch = createTestScratch('reconcile-test-');
test('intentional cleanup oracle failure', () => {
  const root = scratch();
  fs.writeFileSync(path.join(root, 'owned.bin'), 'x');
  assert.fail('intentional cleanup oracle failure');
});
`);

  const child = runChild(
    ['--test', record.fixture],
    record.parent,
    30_000,
    1024 * 1024,
  );
  const output = `${child.stdout}\n${child.stderr}`;
  assert.notEqual(child.status, 0, `assertion-failure child unexpectedly passed:\n${output}`);
  assert.ok(output.includes('intentional cleanup oracle failure'), `expected assertion failure was absent:\n${output}`);
  assert.match(output, /(?:#|ℹ) fail 1\b/, 'failure child did not report one failed test');

  const roots = discoverOwnedRoots(record);
  assert.deepEqual(fs.readFileSync(record.sentinel), SENTINEL, 'assertion-failure child changed the sentinel');
  assert.deepEqual(roots, [], `assertion failure left owned roots: ${roots.join(', ')}`);
  cleanupParent(record);
});
