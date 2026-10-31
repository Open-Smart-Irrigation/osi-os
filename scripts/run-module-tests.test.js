'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkTestFiles, tapSummary, zeroCollectionError } = require('./run-module-tests');

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

test('the runner rejects NODE_OPTIONS test sharding before it can pass with zero tests', () => {
  const root = scratch({
    'a/shard.test.js': "require('node:test')('passes', () => require('node:fs').writeFileSync(process.env.MARKER, 'ran'));\n",
  });
  const marker = path.join(root, 'marker');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  env.NODE_OPTIONS = '--test-shard=2/2';
  env.MARKER = marker;

  const direct = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', 'node --test --test-reporter=tap a/shard.test.js'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.equal(direct.status, 0, `FIXTURE_ERROR: direct sharded Node run: ${direct.stdout}${direct.stderr}`);
  assert.equal(fs.existsSync(marker), false, `FIXTURE_ERROR: shard unexpectedly ran the test: ${direct.stdout}${direct.stderr}`);

  const r = run(root, ['a/shard.test.js'], env);
  assert.equal(r.code, 2, `runner passed a shard with no test execution: ${r.out}`);
  assert.match(r.out, /NODE_OPTIONS.*--test-shard/i);
  assert.equal(fs.existsSync(marker), false, 'runner started the sharded test child');
});

test('real Bash filter controls reject underscore and mixed NODE_OPTIONS names in the runner', async (t) => {
  const cases = [
    ['underscore skip-pattern', '--test_skip_pattern=filtered', 1, true],
    ['mixed skip-pattern', '--test-skip_pattern=filtered', 1, true],
    ['underscore name-pattern', '--test_name_pattern=remaining', 1, true],
    ['mixed name-pattern', '--test-name_pattern=remaining', 1, true],
    ['underscore shard', '--test_shard=2/2', 0, false],
  ];

  for (const [name, option, expectedTests, expectRemaining] of cases) {
    await t.test(name, () => {
      const root = scratch({
        'a/two.test.js': [
          "const t = require('node:test'); const fs = require('node:fs');",
          "t('filtered', () => fs.writeFileSync(process.env.FILTERED_MARKER, 'ran'));",
          "t('remaining', () => fs.writeFileSync(process.env.REMAINING_MARKER, 'ran'));",
          '',
        ].join(' '),
      });
      const filtered = path.join(root, 'filtered-marker');
      const remaining = path.join(root, 'remaining-marker');
      const env = { ...process.env, NODE_OPTIONS: option, FILTERED_MARKER: filtered, REMAINING_MARKER: remaining };
      delete env.NODE_TEST_CONTEXT;
      const direct = spawnSync('bash', [
        '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
        'node --test --test-reporter=tap a/two.test.js',
      ], { cwd: root, encoding: 'utf8', env });
      assert.equal(direct.status, 0, `FIXTURE_ERROR direct Node filter control: ${direct.stdout}${direct.stderr}`);
      assert.equal(fs.existsSync(filtered), false, `FIXTURE_ERROR direct Node did not filter target: ${direct.stdout}${direct.stderr}`);
      assert.equal(fs.existsSync(remaining), expectRemaining, `FIXTURE_ERROR direct Node remaining marker: ${direct.stdout}${direct.stderr}`);
      assert.match(direct.stdout, new RegExp(`# tests ${expectedTests}\\b`), `FIXTURE_ERROR direct Node TAP count: ${direct.stdout}`);

      fs.rmSync(filtered, { force: true });
      fs.rmSync(remaining, { force: true });
      const runnerCommand = `node "${SCRIPT}" a/two.test.js`;
      const runner = spawnSync('bash', [
        '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
        runnerCommand,
      ], { cwd: root, encoding: 'utf8', env });
      assert.equal(runner.status, 2, `runner passed a filtered two-test file: ${runner.stdout}${runner.stderr}`);
      assert.match(runner.stderr, /NODE_OPTIONS.*--test[-_]?(?:skip|name|shard)/i, runner.stderr);
      assert.equal(fs.existsSync(filtered), false, 'runner launched the filtered test');
      assert.equal(fs.existsSync(remaining), false, 'runner launched the unfiltered test before rejecting');
    });
  }
});

test('zero TAP collection is rejected when explicit files were listed', () => {
  const root = scratch({
    'a/two.test.js': "const t = require('node:test'); t('first', () => {}); t('second', () => {});\n",
  });
  const env = { ...process.env, NODE_OPTIONS: '--test-shard=2/2' };
  delete env.NODE_TEST_CONTEXT;
  const direct = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'a/two.test.js'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.equal(direct.status, 0, `FIXTURE_ERROR direct zero-shard control: ${direct.stdout}${direct.stderr}`);
  assert.match(direct.stdout, /^# tests 0$/m, `FIXTURE_ERROR Node did not report zero collection: ${direct.stdout}`);
  const summary = tapSummary(direct.stdout.split(/\r?\n/), ['a/two.test.js']);
  assert.equal(summary.counts.tests, 0, `FIXTURE_ERROR parser did not preserve zero count: ${JSON.stringify(summary)}`);
  assert.equal(typeof zeroCollectionError, 'function', 'runner must guard zero tests for an explicit nonempty file list');
  if (typeof zeroCollectionError !== 'function') return;
  assert.equal(zeroCollectionError(summary.counts, ['a/two.test.js']),
    'node --test collected zero tests for listed files');
  assert.equal(zeroCollectionError(summary.counts, []), null, 'zero guard should be scoped to a nonempty file list');
  assert.equal(zeroCollectionError({ tests: 1 }, ['a/two.test.js']), null, 'nonzero collection should pass this guard');
});

test('a run in which every test is skipped fails', () => {
  const root = scratch({ 'a.test.js': "require('node:test')('later', { skip: true }, () => {});\n" });
  const r = run(root, ['a.test.js']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /every test was skipped/);
});
