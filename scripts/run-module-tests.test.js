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

function run(cwd, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
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
