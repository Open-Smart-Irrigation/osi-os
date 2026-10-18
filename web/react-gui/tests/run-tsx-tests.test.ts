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

// Spins without yielding, like the hang in #393, so nothing inside the file
// can stop it; only the runner's limit can.
const SPINNING = "import test from 'node:test';\ntest('spins', () => { for (;;) {} });\n";

function run(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  // The outer timeout only keeps a broken runner from hanging this test.
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
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

test('a file that runs past the time limit is stopped and named', () => {
  const started = Date.now();
  const r = run(
    scratch({ 'tests/a.test.ts': PASSING, 'tests/hangs.test.ts': SPINNING }),
    ['tests/**/*.test.ts'],
    { RUN_TSX_TESTS_TIMEOUT_MS: '3000' },
  );
  const elapsedMs = Date.now() - started;
  assert.notEqual(r.code, 0, r.out);
  assert.notEqual(r.code, null, 'the runner itself had to be killed');
  assert.match(r.out, /time limit 3000 ms per file/);
  assert.match(r.out, /not ok \d+ - tests\/hangs\.test\.ts/);
  assert.match(r.out, /test timed out after 3000ms/);
  assert.match(r.out, /# pass 1/);
  assert.ok(elapsedMs < 30_000, `the runner took ${elapsedMs} ms`);
});

test('a time limit that is not a positive whole number fails before any test runs', () => {
  const r = run(scratch({ 'tests/a.test.ts': PASSING }), ['tests/**/*.test.ts'], { RUN_TSX_TESTS_TIMEOUT_MS: '2m' });
  assert.equal(r.code, 2);
  assert.match(r.out, /RUN_TSX_TESTS_TIMEOUT_MS must be a positive whole number/);
  assert.doesNotMatch(r.out, /# tests/);
});
