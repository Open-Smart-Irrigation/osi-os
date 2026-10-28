'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkTestFiles } = require('./run-module-tests');

const SCRIPT = path.join(__dirname, 'run-module-tests.js');

const tempRoots = [];
process.on('exit', () => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function scratch(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-module-tests-'));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

function run(cwd, args, env = process.env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout + r.stderr };
}

const PASSING = "require('node:test')('passes', () => {});\n";
const FAILING = "require('node:test')('fails', () => { throw new Error('boom'); });\n";

test('checkTestFiles accepts existing regular files', (t) => {
  const root = scratch({ 'a/one.test.js': PASSING, 'a/two.test.js': PASSING });
  assert.deepEqual(checkTestFiles(['a/one.test.js', 'a/two.test.js'], root), []);
});

test('checkTestFiles rejects an empty list', () => {
  assert.match(checkTestFiles([], os.tmpdir()).join('\n'), /no test files/);
});

test('checkTestFiles rejects a missing file, a directory, a glob and an option', () => {
  const root = scratch({ 'a/one.test.js': PASSING });
  const errors = checkTestFiles(['a/gone.test.js', 'a', 'a/*.test.js', '--watch'], root).join('\n');
  assert.match(errors, /a\/gone\.test\.js: file not found/);
  assert.match(errors, /a: not a regular file/);
  assert.match(errors, /a\/\*\.test\.js: glob patterns are not allowed/);
  assert.match(errors, /--watch: options are not allowed/);
});

test('checkTestFiles rejects a file listed twice', () => {
  const root = scratch({ 'a/one.test.js': PASSING });
  assert.match(checkTestFiles(['a/one.test.js', './a/one.test.js'], root).join('\n'), /listed twice/);
});

test('no arguments fails before node --test runs', () => {
  const r = run(os.tmpdir(), []);
  assert.equal(r.code, 2);
  assert.match(r.out, /no test files/);
  assert.doesNotMatch(r.out, /# tests/);
});

test('one missing file fails the whole step even when the others exist', () => {
  // node --test a.test.js missing.test.js exits 0 and runs only a.test.js.
  const root = scratch({ 'a.test.js': PASSING });
  const r = run(root, ['a.test.js', 'renamed.test.js']);
  assert.equal(r.code, 2);
  assert.match(r.out, /renamed\.test\.js: file not found/);
  assert.doesNotMatch(r.out, /# tests/);
});

test('a glob that would match nothing fails instead of passing', () => {
  const root = scratch({ 'a.test.js': PASSING });
  const r = run(root, ['missing/*.test.js']);
  assert.equal(r.code, 2);
  assert.match(r.out, /glob patterns are not allowed/);
});

test('passing files run under node --test and exit 0', () => {
  const root = scratch({ 'a.test.js': PASSING, 'b.test.js': PASSING });
  const r = run(root, ['a.test.js', 'b.test.js']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /# pass 2/);
  assert.match(r.out, /run-module-tests: 2 test files/);
});

test('a failing test propagates a nonzero exit', () => {
  const root = scratch({ 'a.test.js': PASSING, 'b.test.js': FAILING });
  const r = run(root, ['a.test.js', 'b.test.js']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /# fail 1/);
});

test('a listed file with no tests fails', () => {
  // node --test reports a file without test() calls as one passing test.
  const root = scratch({ 'a.test.js': PASSING, 'empty.test.js': '// all tests were deleted\n' });
  const r = run(root, ['a.test.js', 'empty.test.js']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /empty\.test\.js contains no tests/);
});

test('an empty file passed with a ./ prefix fails the whole step', () => {
  const root = scratch({ 'a/empty.test.js': '// all tests were deleted\n' });
  const r = run(root, ['./a/empty.test.js']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /a\/empty\.test\.js contains no tests/);
  assert.match(r.out, /# tests 1/, 'Node must have reported the listed empty file');
});

test('the runner clears NODE_TEST_CONTEXT before starting its child', () => {
  const root = scratch({ 'a/ok.test.js': PASSING });
  const env = { ...process.env, NODE_OPTIONS: '--enable-source-maps', NODE_TEST_CONTEXT: 'child' };
  const r = run(root, ['a/ok.test.js'], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /# pass 1/);
});

test('the runner rejects or clears a partial NODE_OPTIONS test filter', () => {
  const root = scratch({
    'a/two.test.js': [
      "const test = require('node:test');",
      "const fs = require('node:fs');",
      "test('filtered', () => fs.writeFileSync(process.env.FIRST_MARKER, 'ran'));",
      "test('still-runs', () => fs.writeFileSync(process.env.SECOND_MARKER, 'ran'));",
      '',
    ].join(' '),
  });
  const first = path.join(root, 'first-marker');
  const second = path.join(root, 'second-marker');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  env.NODE_OPTIONS = '--test-skip-pattern=filtered';
  env.FIRST_MARKER = first;
  env.SECOND_MARKER = second;

  const direct = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'a/two.test.js'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.equal(direct.status, 0, `FIXTURE_ERROR: direct filtered Node run: ${direct.stdout}${direct.stderr}`);
  assert.equal(fs.existsSync(first), false, `FIXTURE_ERROR: filter did not suppress matching test: ${direct.stdout}`);
  assert.equal(fs.existsSync(second), true, `FIXTURE_ERROR: filter suppressed unrelated test: ${direct.stdout}`);
  fs.rmSync(second);

  const r = run(root, ['a/two.test.js'], env);
  if (r.code === 0) {
    assert.equal(fs.existsSync(first), true, `runner passed without running filtered test: ${r.out}`);
    assert.equal(fs.existsSync(second), true, `runner passed without running remaining test: ${r.out}`);
  } else {
    assert.match(r.out, /NODE_OPTIONS|filter/i, `runner rejection must name the filter: ${r.out}`);
  }
});

test('a run in which every test is skipped fails', () => {
  const root = scratch({ 'a.test.js': "require('node:test')('later', { skip: true }, () => {});\n" });
  const r = run(root, ['a.test.js']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /every test was skipped/);
});
