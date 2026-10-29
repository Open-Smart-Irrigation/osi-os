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
const ASSERTION_TOKEN = 'RECONCILE_SCRATCH_ASSERTION_TOKEN_R2';
const REACHED_MARKER = 'RECONCILE_SCRATCH_REACHED_AFTER_OWNED_BIN_WRITE_R2';
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
  try {
    parents.add(record);
  } catch (error) {
    try {
      fs.rmdirSync(parent);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
  try {
    fs.writeFileSync(record.sentinel, SENTINEL);
  } catch (error) {
    try {
      cleanupParent(record);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
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
  const allowed = new Set(['sentinel.bin', ...record.roots]);
  if (fixtureName) allowed.add(fixtureName);
  const unexpected = names.filter((name) => !allowed.has(name));

  const failures = [];
  for (const name of record.roots) {
    try {
      fs.rmSync(path.join(record.parent, name), { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  for (const ownedPath of [record.fixture, record.sentinel]) {
    if (!ownedPath || !fs.existsSync(ownedPath)) continue;
    try {
      fs.unlinkSync(ownedPath);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'oracle owned-path cleanup failed');
  if (unexpected.length) {
    throw new Error(`preserving private TMPDIR with unexpected entries: ${unexpected.join(', ')}`);
  }
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

function assertIntentionalAssertionReached(child) {
  const output = `${child.stdout}\n${child.stderr}`;
  assert.notEqual(child.status, 0, `assertion-failure child unexpectedly passed:\n${output}`);
  assert.match(output, /(?:#|ℹ) fail 1\b/, 'failure child did not report one failed test');
  assert.match(
    output,
    new RegExp(`error:\\s*['"]${ASSERTION_TOKEN}['"]`),
    'failure child did not report the intended assertion diagnostic',
  );
  assert.ok(child.stdout.includes(REACHED_MARKER), 'failure child did not reach the post-owned.bin-write marker');
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

test('test-owned scratch cleanup runs after an assertion failure and preserves the sentinel', (t) => {
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
  process.stdout.write('${REACHED_MARKER}\\n');
  assert.fail('${ASSERTION_TOKEN}');
});
`);

  const child = runChild(
    ['--test', record.fixture],
    record.parent,
    30_000,
    1024 * 1024,
  );
  const output = `${child.stdout}\n${child.stderr}`;
  t.diagnostic(`assertion-failure child stdout:\n${child.stdout}`);
  t.diagnostic(`assertion-failure child stderr:\n${child.stderr}`);
  assertIntentionalAssertionReached(child);

  const roots = discoverOwnedRoots(record);
  assert.deepEqual(fs.readFileSync(record.sentinel), SENTINEL, 'assertion-failure child changed the sentinel');
  assert.deepEqual(roots, [], `assertion failure left owned roots: ${roots.join(', ')}`);
  cleanupParent(record);
});

test('failure oracle rejects an owned.bin setup error before its intentional assertion', (t) => {
  const record = createPrivateParent('setup-failure.cjs');
  const helperImport = JSON.stringify(HELPER);
  fs.writeFileSync(record.fixture, `
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createTestScratch } = require(${helperImport});
const scratch = createTestScratch('reconcile-test-');
test('owned.bin setup fails before the intentional assertion', () => {
  const root = scratch();
  fs.mkdirSync(path.join(root, 'owned.bin'));
  fs.writeFileSync(path.join(root, 'owned.bin'), 'x');
  process.stdout.write('${REACHED_MARKER}\\n');
  assert.fail('${ASSERTION_TOKEN}');
});
`);

  const child = runChild(
    ['--test', record.fixture],
    record.parent,
    30_000,
    1024 * 1024,
  );
  const output = `${child.stdout}\n${child.stderr}`;
  t.diagnostic(`setup-failure mutant child stdout:\n${child.stdout}`);
  t.diagnostic(`setup-failure mutant child stderr:\n${child.stderr}`);
  assert.notEqual(child.status, 0, `setup-failure mutant unexpectedly passed:\n${output}`);
  assert.match(output, /(?:#|ℹ) fail 1\b/, 'setup-failure mutant did not report one failed test');
  assert.match(output, /EISDIR/, 'setup-failure mutant did not fail while writing owned.bin');
  assert.equal(output.includes(ASSERTION_TOKEN), false, 'setup-failure mutant reached the intentional assertion');
  assert.equal(child.stdout.includes(REACHED_MARKER), false, 'setup-failure mutant reached the post-write marker');
  assert.throws(
    () => assertIntentionalAssertionReached(child),
    /failure child did not report the intended assertion diagnostic/,
    'parent oracle accepted a setup failure as the intentional assertion',
  );

  const roots = discoverOwnedRoots(record);
  assert.deepEqual(fs.readFileSync(record.sentinel), SENTINEL, 'setup-failure mutant changed the sentinel');
  assert.deepEqual(roots, [], `setup failure left owned roots: ${roots.join(', ')}`);
  cleanupParent(record);
});
