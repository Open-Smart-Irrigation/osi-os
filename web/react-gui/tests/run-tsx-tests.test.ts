import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// scripts/run-tsx-tests.mjs collects the GUI's node:test suites. `tsx --test
// 'tests/**/*.test.ts'` exits 0 with zero tests when the pattern matches
// nothing; the runner must exit nonzero instead.

const RUNNER = path.resolve('scripts/run-tsx-tests.mjs');
const PASSING = "import test from 'node:test';\ntest('passes', () => {});\n";
const FAILING = "import test from 'node:test';\ntest('fails', () => { throw new Error('boom'); });\n";

function scratch(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tsx-tests-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

function run(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd, env, encoding: 'utf8' });
  fs.rmSync(cwd, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('no pattern fails', () => {
  const r = run(scratch({}), []);
  assert.equal(r.code, 2);
  assert.match(r.out, /no patterns/);
});

test('a pattern that matches nothing fails before any test runs', () => {
  const r = run(scratch({ 'tests/a.test.ts': PASSING }), ['tests/**/*.test.ts', 'moved/**/*.test.ts']);
  assert.equal(r.code, 2);
  assert.match(r.out, /moved\/\*\*\/\*\.test\.ts matches no file/);
  assert.doesNotMatch(r.out, /# tests/);
});

test('matched files run under tsx --test and exit 0', () => {
  const r = run(scratch({ 'tests/a.test.ts': PASSING, 'tests/sub/b.test.ts': PASSING }), ['tests/**/*.test.ts']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /run-tsx-tests: 2 test files/);
  assert.match(r.out, /# pass 2/);
});

test('a failing test propagates a nonzero exit', () => {
  const r = run(scratch({ 'tests/a.test.ts': PASSING, 'tests/b.test.ts': FAILING }), ['tests/**/*.test.ts']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /# fail 1/);
});
