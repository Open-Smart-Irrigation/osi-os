'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseYaml, shellCommands, isTestFile, verify } = require('./verify-test-inventory');

const SCRIPT = path.join(__dirname, 'verify-test-inventory.js');
const REPO_ROOT = path.resolve(__dirname, '..');

const tempRoots = [];
process.on('exit', () => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-inventory-'));
  tempRoots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

function workflow(steps, extra = '') {
  return [
    'name: Fixture',
    'on:',
    '  pull_request:',
    '    branches: [ main ]',
    extra,
    'jobs:',
    '  check:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '22'",
    ...steps.map((s) => `      - run: ${s}`),
    '',
  ].join('\n');
}

const INVENTORY = 'scripts/verify-test-inventory.json';
const EMPTY_INVENTORY = JSON.stringify({ indirect: [], excluded: [] });
const PASSING = "require('node:test')('ok', () => {});\n";

function errorsOf(root) {
  return verify(root).errors.join('\n');
}

// ---------------------------------------------------------------- YAML subset

test('parseYaml reads the workflow subset: maps, sequences, flow lists, quotes, comments', () => {
  const doc = parseYaml([
    '# leading comment',
    'name: Demo',
    'on:',
    '  push:',
    "    branches: [ main, 'release' ]",
    'jobs:',
    '  a:',
    '    steps:',
    '    - uses: actions/setup-node@v4',
    '      with:',
    "        node-version: '22'  # trailing comment",
    '    - run: node "scripts/x.js" # note',
    "      name: 'it''s'",
    '',
  ].join('\n'), 'demo.yml');
  assert.deepEqual(doc, {
    name: 'Demo',
    on: { push: { branches: ['main', 'release'] } },
    jobs: { a: { steps: [
      { uses: 'actions/setup-node@v4', with: { 'node-version': '22' } },
      { run: 'node "scripts/x.js"', name: "it's" },
    ] } },
  });
});

test('parseYaml keeps literal blocks and folds folded blocks', () => {
  const doc = parseYaml([
    'a: |',
    '  one',
    '  # not a comment',
    '',
    '  two',
    'b: >',
    '  node --test',
    '  x.test.js',
    'c: |-',
    '  kept',
    '',
  ].join('\n'), 'blocks.yml');
  assert.equal(doc.a, 'one\n# not a comment\n\ntwo\n');
  assert.equal(doc.b, 'node --test x.test.js\n');
  assert.equal(doc.c, 'kept');
});

test('parseYaml fails closed on constructs it does not model', () => {
  for (const [text, re] of [
    ['a:\n\tb: 1\n', /tab/],
    ['a: &anchor 1\n', /anchor|alias|tag/],
    ['a: {b: 1}\n', /flow mapping/],
    ['a: one\n  continued\n', /indentation/],
    ['a: x: y\n', /plain scalar/],
    ['a: 1\na: 2\n', /duplicate key/],
    ["a: 'open\n", /quote/],
  ]) {
    assert.throws(() => parseYaml(text, 'bad.yml'), re, text);
  }
});

// The verifier parses workflows with its own reader (parseYaml above); this
// cross-check needs python3 with PyYAML and is skipped, visibly, without it.
const HAS_PYYAML = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' }).status === 0;

test('parseYaml agrees with PyYAML on every workflow in this repository', { skip: HAS_PYYAML ? false : 'python3 with PyYAML is not installed' }, () => {
  const normalize = [
    'import json, sys, yaml',
    'def n(v):',
    "    if isinstance(v, bool): return 'true' if v else 'false'",
    '    if isinstance(v, (int, float)): return str(v)',
    "    if isinstance(v, dict): return {('on' if k is True else str(k)): n(x) for k, x in v.items()}",
    '    if isinstance(v, list): return [n(x) for x in v]',
    '    return v',
    'print(json.dumps(n(yaml.safe_load(open(sys.argv[1])))))',
  ].join('\n');
  const dir = path.join(REPO_ROOT, '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const full = path.join(dir, f);
    const expected = JSON.parse(execFileSync('python3', ['-c', normalize, full], { encoding: 'utf8' }));
    assert.deepEqual(parseYaml(fs.readFileSync(full, 'utf8'), f), expected, f);
  }
});

// ---------------------------------------------------------------- shell words

test('shellCommands splits commands and keeps quoted words whole', () => {
  const cmds = shellCommands("set -e\nA=1 node --test 'a b.test.js' x.js && echo \"y; z\" | sh s.sh\nif grep -q x f; then node t.js; fi");
  assert.deepEqual(cmds, [
    ['set', '-e'],
    ['A=1', 'node', '--test', 'a b.test.js', 'x.js'],
    ['echo', 'y; z'],
    ['sh', 's.sh'],
    ['if', 'grep', '-q', 'x', 'f'],
    ['then', 'node', 't.js'],
    ['fi'],
  ]);
});

test('shellCommands drops redirections and their targets', () => {
  assert.deepEqual(shellCommands('node --test a.test.js 2>&1 | tee /tmp/out\necho x > f.js\ncat < in.txt >>log'), [
    ['node', '--test', 'a.test.js'],
    ['tee', '/tmp/out'],
    ['echo', 'x'],
    ['cat'],
  ]);
});

test('shellCommands joins backslash-continued lines', () => {
  assert.deepEqual(shellCommands('node --test \\\n  a.test.js \\\n  b.test.js\n'), [['node', '--test', 'a.test.js', 'b.test.js']]);
});

test('isTestFile follows the naming rules', () => {
  for (const f of ['scripts/a.test.js', 'scripts/test-a.js', 'x/y.spec.ts', 'x/y.test.tsx', 'scripts/a.test.sh', 'scripts/test-a.sh', 'p/tests/test_a.py', 'web/s/a.test.mjs', 'tests/harness/selftest.js']) {
    assert.ok(isTestFile(f), f);
  }
  for (const f of ['scripts/testing.js', 'scripts/a.js', 'x/__tests__/helpers/h.js', 'scripts/verify-a.js']) {
    assert.ok(!isTestFile(f), f);
  }
});

// ---------------------------------------------------------------- inventory

test('a test file run by a workflow passes', () => {
  const root = repo({
    '.github/workflows/ci.yml': workflow(['node --test scripts/a.test.js']),
    'scripts/a.test.js': PASSING,
    [INVENTORY]: EMPTY_INVENTORY,
  });
  const result = verify(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.found, 1);
  assert.equal(result.stats.run, 1);
});

test('a test file that no workflow runs fails', () => {
  const root = repo({
    '.github/workflows/ci.yml': workflow(['node --test scripts/a.test.js']),
    'scripts/a.test.js': PASSING,
    'scripts/test-orphan.js': PASSING,
    [INVENTORY]: EMPTY_INVENTORY,
  });
  assert.match(errorsOf(root), /scripts\/test-orphan\.js: no workflow runs this test/);
});

test('a glob in a test command fails even when it matches files', () => {
  const root = repo({
    '.github/workflows/ci.yml': workflow(['node --test scripts/*.test.js']),
    'scripts/a.test.js': PASSING,
    [INVENTORY]: EMPTY_INVENTORY,
  });
  assert.match(errorsOf(root), /scripts\/\*\.test\.js: glob .*list each file/);
});

test('a renamed test file named by a workflow fails', () => {
  const root = repo({
    '.github/workflows/ci.yml': workflow(['node scripts/run-module-tests.js scripts/a.test.js scripts/old-name.test.js']),
    'scripts/run-module-tests.js': '',
    'scripts/a.test.js': PASSING,
    [INVENTORY]: EMPTY_INVENTORY,
  });
  assert.match(errorsOf(root), /scripts\/old-name\.test\.js: not a tracked file/);
});

test('node --test without explicit files fails', () => {
  const root = repo({
    '.github/workflows/ci.yml': workflow(['node --test', 'node --test scripts/a.test.js']),
    'scripts/a.test.js': PASSING,
    [INVENTORY]: EMPTY_INVENTORY,
  });
  assert.match(errorsOf(root), /node --test without explicit test files/);
});

test('working directories resolve relative paths', () => {
  const root = repo({
    '.github/workflows/ci.yml': workflow(['node --test a.test.js'], 'defaults:\n  run:\n    working-directory: pkg'),
    'pkg/a.test.js': PASSING,
    [INVENTORY]: EMPTY_INVENTORY,
  });
  assert.deepEqual(verify(root).errors, []);
});

test('an exclusion needs a reason, must match an unrun test, and must not exclude a run test', () => {
  const files = {
    '.github/workflows/ci.yml': workflow(['node --test scripts/a.test.js']),
    'scripts/a.test.js': PASSING,
    'scripts/b.test.js': PASSING,
    'vendor/x/test-y.js': PASSING,
  };
  const ok = repo({ ...files, [INVENTORY]: JSON.stringify({ indirect: [], excluded: [
    { path: 'scripts/b.test.js', reason: 'needs hardware that CI does not have' },
    { pattern: 'vendor/**', reason: 'third-party code with its own tests' },
  ] }) });
  assert.deepEqual(verify(ok).errors, []);
  assert.equal(verify(ok).stats.excluded, 2);

  const bad = repo({ ...files, [INVENTORY]: JSON.stringify({ indirect: [], excluded: [
    { path: 'scripts/b.test.js', reason: '' },
    { path: 'scripts/a.test.js', reason: 'run elsewhere, contradiction' },
    { path: 'scripts/gone.test.js', reason: 'deleted long ago, stale entry' },
    { pattern: 'nothing/**', reason: 'matches no file, stale entry' },
    { pattern: 'vendor/**', path: 'vendor/x/test-y.js', reason: 'both keys given' },
  ] }) });
  const errors = errorsOf(bad);
  assert.match(errors, /scripts\/b\.test\.js: exclusion needs a reason/);
  assert.match(errors, /scripts\/a\.test\.js: excluded but a workflow runs it/);
  assert.match(errors, /scripts\/gone\.test\.js: exclusion names no test file/);
  assert.match(errors, /nothing\/\*\*: exclusion pattern matches no unrun test file/);
  assert.match(errors, /exactly one of path or pattern/);
});

test('an indirect test counts only when its runner runs and names it', () => {
  const files = {
    '.github/workflows/ci.yml': workflow(['node scripts/umbrella.js']),
    'scripts/umbrella.js': "require('child_process').execFileSync(process.execPath, [require('path').join(__dirname, 'test-chained.js')]);\n",
    'scripts/test-chained.js': PASSING,
    'scripts/quiet.js': '// runs nothing\n',
    'scripts/test-other.js': PASSING,
  };
  const mixed = repo({ ...files, [INVENTORY]: JSON.stringify({ excluded: [], indirect: [
    { path: 'scripts/test-chained.js', runner: 'scripts/umbrella.js' },
    { path: 'scripts/test-other.js', runner: 'scripts/test-chained.js' },
  ] }) });
  const mixedErrors = errorsOf(mixed);
  assert.match(mixedErrors, /scripts\/test-other\.js: runner scripts\/test-chained\.js does not name it/);
  assert.doesNotMatch(mixedErrors, /test-chained\.js: runner/);

  const bad = repo({ ...files, [INVENTORY]: JSON.stringify({ excluded: [], indirect: [
    { path: 'scripts/test-chained.js', runner: 'scripts/quiet.js' },
    { path: 'scripts/test-other.js', runner: 'scripts/umbrella.js' },
  ] }) });
  const errors = errorsOf(bad);
  assert.match(errors, /scripts\/test-chained\.js: runner scripts\/quiet\.js is not run by any workflow/);
  assert.match(errors, /scripts\/test-other\.js: runner scripts\/umbrella\.js does not name it/);
});

test('an indirect entry for a test a workflow already runs is redundant', () => {
  const root = repo({
    '.github/workflows/ci.yml': workflow(['node scripts/umbrella.js', 'node --test scripts/test-chained.js']),
    'scripts/umbrella.js': "// test-chained.js\n",
    'scripts/test-chained.js': PASSING,
    [INVENTORY]: JSON.stringify({ excluded: [], indirect: [{ path: 'scripts/test-chained.js', runner: 'scripts/umbrella.js' }] }),
  });
  assert.match(errorsOf(root), /scripts\/test-chained\.js: indirect entry is redundant/);
});

test('setup-node must pin a numeric Node version', () => {
  const base = { 'scripts/a.test.js': PASSING, [INVENTORY]: EMPTY_INVENTORY };
  for (const version of ['lts/*', 'latest', 'node']) {
    const root = repo({ ...base, '.github/workflows/ci.yml': workflow(['node --test scripts/a.test.js']).replace("'22'", `'${version}'`) });
    assert.match(errorsOf(root), /node-version .* is not a pinned version/, version);
  }
  const missing = repo({ ...base, '.github/workflows/ci.yml': workflow(['node --test scripts/a.test.js']).replace("        with:\n          node-version: '22'\n", '') });
  assert.match(errorsOf(missing), /setup-node without node-version/);
});

test('workflows install with npm ci only, without peer-dependency bypasses', () => {
  for (const [cmd, re] of [
    ['npm install', /npm install: use npm ci/],
    ['npm i', /npm i: use npm ci/],
    ['npm ci --legacy-peer-deps', /--legacy-peer-deps is not allowed/],
    ['npm ci --force', /--force is not allowed/],
  ]) {
    const root = repo({
      '.github/workflows/ci.yml': workflow([cmd, 'node --test scripts/a.test.js']),
      'scripts/a.test.js': PASSING,
      [INVENTORY]: EMPTY_INVENTORY,
    });
    assert.match(errorsOf(root), re, cmd);
  }
});

function guiRepo(scripts, extraFiles = {}) {
  return repo({
    '.github/workflows/ci.yml': workflow(['npm ci', 'npm run test:unit'], 'defaults:\n  run:\n    working-directory: gui'),
    'gui/package.json': JSON.stringify({ scripts }),
    'gui/scripts/run-tsx-tests.mjs': '',
    'gui/src/a/__tests__/one.test.ts': '',
    'gui/src/b/__tests__/two.test.tsx': '',
    'gui/tests/three.test.ts': '',
    [INVENTORY]: EMPTY_INVENTORY,
    ...extraFiles,
  });
}

test('npm scripts: vitest filters and the checked tsx runner collect GUI tests', () => {
  const root = guiRepo({
    'test:unit': 'npm run test:unit:tsx && npm run test:unit:vitest',
    'test:unit:tsx': "node scripts/run-tsx-tests.mjs 'tests/**/*.test.ts'",
    'test:unit:vitest': 'vitest run src/a/__tests__ src/b/__tests__',
  });
  const result = verify(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.run, 3);
});

test('npm scripts: a Playwright config is a runner for its browser spec', () => {
  const root = repo({
    '.github/workflows/ci.yml': workflow(['npm ci', 'npm run test:browser:conditional'], 'defaults:\n  run:\n    working-directory: gui'),
    'gui/package.json': JSON.stringify({ scripts: { 'test:browser:conditional': 'playwright test --config playwright.conditional.config.ts' } }),
    'gui/playwright.conditional.config.ts': "testMatch: '**/conditional-irrigation.spec.ts'\n",
    'gui/tests/browser/conditional-irrigation.spec.ts': '',
    [INVENTORY]: JSON.stringify({ excluded: [], indirect: [{
      path: 'gui/tests/browser/conditional-irrigation.spec.ts',
      runner: 'gui/playwright.conditional.config.ts',
    }] }),
  });
  assert.deepEqual(verify(root).errors, []);
});

test('npm scripts: a GUI test outside every vitest filter fails', () => {
  const root = guiRepo({
    'test:unit': "node scripts/run-tsx-tests.mjs 'tests/**/*.test.ts' && vitest run src/a/__tests__",
  });
  assert.match(errorsOf(root), /gui\/src\/b\/__tests__\/two\.test\.tsx: no workflow runs this test/);
});

test('npm scripts: --passWithNoTests, an empty filter, an empty glob and a raw tsx glob fail', () => {
  const root = guiRepo({
    'test:unit': [
      'vitest run src/a/__tests__ src/b/__tests__ src/gone/__tests__ --passWithNoTests',
      "node scripts/run-tsx-tests.mjs 'tests/**/*.test.ts' 'moved/**/*.test.ts'",
      "tsx --test 'tests/**/*.test.ts'",
    ].join(' && '),
  });
  const errors = errorsOf(root);
  assert.match(errors, /--passWithNoTests/);
  assert.match(errors, /vitest filter src\/gone\/__tests__ matches no test file/);
  assert.match(errors, /moved\/\*\*\/\*\.test\.ts matches no tracked file/);
  assert.match(errors, /tsx --test: collect tests through scripts\/run-tsx-tests\.mjs/);
});

test('npm scripts: a missing script fails', () => {
  const root = guiRepo({ 'test:unit': 'npm run nope' });
  assert.match(errorsOf(root), /npm script "nope" not found/);
});

// ------------------------------------------- steps that cannot fail a pull request

function gated({ on = '  pull_request:\n    branches: [ main ]', workflowEnv = '', job = '', jobEnv = '', step = '', run, shell = '' }) {
  return [
    'name: Gated',
    'on:',
    on,
    workflowEnv,
    'jobs:',
    '  check:',
    '    runs-on: ubuntu-latest',
    job,
    jobEnv,
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: the step under test',
    step,
    shell,
    '        run: |',
    ...run.split('\n').map((l) => `          ${l}`),
    '',
  ].filter((l) => l !== '').join('\n');
}

function gatedRepo(spec, extra = {}) {
  return repo({
    '.github/workflows/ci.yml': gated(spec),
    'scripts/a.test.js': PASSING,
    'scripts/other.js': '// a script that takes file arguments\n',
    [INVENTORY]: EMPTY_INVENTORY,
    ...extra,
  });
}

const NOT_RUN = /scripts\/a\.test\.js: no workflow runs this test/;

function inventoryCli(root) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [SCRIPT, `--root=${root}`], { cwd: root, encoding: 'utf8', env });
}

const MARKER_TEST = "require('node:test')('passes', () => require('node:fs').writeFileSync(process.env.MARKER, 'ran'));\n";
const FAIL_MARKER_TEST = "require('node:test')('fails', () => { require('node:fs').writeFileSync(process.env.MARKER, 'ran'); throw new Error('boom'); });\n";
const FAIL_MARKER_PASSES = "require('node:test')('passes', () => { require('node:fs').writeFileSync(process.env.MARKER, 'ran'); throw new Error('boom'); });\n";

function bashStep(root, run, inherited = {}) {
  const marker = path.join(root, 'marker');
  const env = { ...process.env, MARKER: marker };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, inherited);
  const child = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', run], {
    cwd: root, encoding: 'utf8', env,
  });
  return { child, marker };
}

function assertUnrun(root, label) {
  const result = verify(root);
  const cli = inventoryCli(root);
  const diagnostic = result.errors.join('\n');
  const uncovered = NOT_RUN.test(diagnostic) && result.status.has('scripts/a.test.js') === false;
  const cliUncovered = cli.status === 1 && /verify-test-inventory: FAIL/.test(cli.stderr) && NOT_RUN.test(cli.stderr);
  assert.ok(uncovered && cliUncovered,
    `${label}: verifier errors=${JSON.stringify(result.errors)}; status=${JSON.stringify(result.status.get('scripts/a.test.js'))}; CLI status=${cli.status}; stdout=${cli.stdout}; stderr=${cli.stderr}`);
}

function assertRun(root, label) {
  const result = verify(root);
  const cli = inventoryCli(root);
  assert.deepEqual(result.errors, [], `${label}: ${result.errors.join('\n')}`);
  assert.equal(result.status.get('scripts/a.test.js')?.kind, 'run', `${label}: exported verifier status`);
  assert.equal(cli.status, 0, `${label}: CLI status ${cli.status}; stdout=${cli.stdout}; stderr=${cli.stderr}`);
}

function assertBashSuppressed(spec, label, inherited = {}, failingBody = FAIL_MARKER_TEST) {
  const passingRoot = gatedRepo(spec, { 'scripts/a.test.js': MARKER_TEST });
  const passing = bashStep(passingRoot, spec.run, inherited);
  assert.equal(passing.child.status, 0, `FIXTURE_ERROR ${label} passing Bash: ${passing.child.stdout}${passing.child.stderr}`);
  assert.equal(fs.existsSync(passing.marker), false, `FIXTURE_ERROR ${label} passing Bash reached marker`);

  const failingRoot = gatedRepo(spec, { 'scripts/a.test.js': failingBody });
  const failing = bashStep(failingRoot, spec.run, inherited);
  assert.equal(failing.child.status, 0, `FIXTURE_ERROR ${label} failing Bash: ${failing.child.stdout}${failing.child.stderr}`);
  assert.equal(fs.existsSync(failing.marker), false, `FIXTURE_ERROR ${label} failing Bash reached marker`);
  assertUnrun(passingRoot, label);
}

function assertBashMasksFailure(spec, label) {
  const passingRoot = gatedRepo(spec, { 'scripts/a.test.js': MARKER_TEST });
  const passing = bashStep(passingRoot, spec.run);
  assert.equal(passing.child.status, 0, `FIXTURE_ERROR ${label} passing Bash: ${passing.child.stdout}${passing.child.stderr}`);
  assert.equal(fs.existsSync(passing.marker), true, `FIXTURE_ERROR ${label} passing Bash did not reach marker`);

  const failingRoot = gatedRepo(spec, { 'scripts/a.test.js': FAIL_MARKER_TEST });
  const failing = bashStep(failingRoot, spec.run);
  assert.equal(failing.child.status, 0, `FIXTURE_ERROR ${label} failing Bash: ${failing.child.stdout}${failing.child.stderr}`);
  assert.equal(fs.existsSync(failing.marker), true, `FIXTURE_ERROR ${label} failing Bash did not reach marker`);
  assertUnrun(passingRoot, label);
}

test('a test in a step or job that cannot fail a pull request is not run', () => {
  for (const [spec, reason] of [
    [{ step: '        if: false', run: 'node --test scripts/a.test.js' }, /if: false/],
    [{ step: "        if: ${{ false }}", run: 'node --test scripts/a.test.js' }, /if: false/],
    [{ step: '        continue-on-error: true', run: 'node --test scripts/a.test.js' }, /continue-on-error/],
    [{ job: '    if: false', run: 'node --test scripts/a.test.js' }, /if: false/],
    [{ job: '    continue-on-error: true', run: 'node --test scripts/a.test.js' }, /continue-on-error/],
    [{ on: '  workflow_dispatch:', run: 'node --test scripts/a.test.js' }, /no pull_request trigger/],
    [{ on: '  push:\n    branches: [ main ]', run: 'node --test scripts/a.test.js' }, /no pull_request trigger/],
    [{ on: "  pull_request:\n    paths: [ 'web/**' ]", run: 'node --test scripts/a.test.js' }, /path filter/],
    [{ on: '  pull_request:\n    types: [ closed ]', run: 'node --test scripts/a.test.js' }, /skips opened or synchronize/],
  ]) {
    const errors = errorsOf(gatedRepo(spec));
    assert.match(errors, NOT_RUN, JSON.stringify(spec));
    assert.match(errors, reason, JSON.stringify(spec));
  }
});

test('a test command whose exit status is discarded is not run', () => {
  for (const [run, reason] of [
    ['node --test scripts/a.test.js || true', /exit status is discarded \(\|\|\)/],
    ['node --test scripts/a.test.js | tee out.txt', /pipe without pipefail/],
    ['node scripts/a.test.js 2>&1 | tee out.txt && grep -q OK out.txt', /pipe without pipefail/],
    ['node --test scripts/a.test.js &', /background/],
    ['node --test scripts/a.test.js && echo done\necho next', /not the last command/],
    ['if node --test scripts/a.test.js; then echo ok; fi', /condition of if/],
    ['! node --test scripts/a.test.js', /condition of !/],
  ]) {
    const errors = errorsOf(gatedRepo({ run }));
    assert.match(errors, NOT_RUN, run);
    assert.match(errors, reason, run);
  }
});

test('unreachable or masked shell tests do not count as workflow runs', () => {
  for (const run of [
    '{ node --test scripts/a.test.js; } || true',
    'if false; then node --test scripts/a.test.js; fi',
    'true || node --test scripts/a.test.js',
    'exit 0\nnode --test scripts/a.test.js',
    'NODE_OPTIONS=--test-skip-pattern=ok node --test scripts/a.test.js',
  ]) {
    assertUnrun(gatedRepo({ run }), run);
  }
});

test('a false then-branch stays unreachable with else, nesting and a word named fi', async (t) => {
  for (const run of [
    'if false; then node --test scripts/a.test.js; else echo skipped; fi',
    'if false; then if true; then echo nested; fi; node --test scripts/a.test.js; fi',
    'if false; then echo fi; node --test scripts/a.test.js; fi',
  ]) {
    await t.test(run, () => assertBashSuppressed({ run }, run));
  }

  const reachableRun = 'if false; then echo skipped; else node --test scripts/a.test.js; fi';
  const reachableRoot = gatedRepo({ run: reachableRun }, { 'scripts/a.test.js': MARKER_TEST });
  const control = bashStep(reachableRoot, reachableRun);
  assert.equal(control.child.status, 0, `FIXTURE_ERROR reachable else branch: ${control.child.stdout}${control.child.stderr}`);
  assert.equal(fs.existsSync(control.marker), true, 'reachable else branch did not reach marker');
  assertRun(reachableRoot, 'reachable else branch');
});

test('brace groups whose failing status is discarded do not count as runs', async (t) => {
  for (const run of [
    '{ node --test scripts/a.test.js; } || echo ignored',
    '{ node --test scripts/a.test.js; } || :',
    '{ node --test scripts/a.test.js; } &\nwait',
  ]) {
    await t.test(run, () => assertBashMasksFailure({ run }, run));
  }
});

test('colon short-circuit leaves the right-hand test unreachable', () => {
  const run = ': || node --test scripts/a.test.js';
  assertBashSuppressed({ run }, 'colon short-circuit');
});

test('workflow environment is inherited by test steps and step values override it', () => {
  for (const [key, value] of [
    ['NODE_OPTIONS', '--test-skip-pattern=ok'],
    ['NODE_TEST_CONTEXT', 'child'],
  ]) {
    for (const [scope, field, envBlock] of [
      ['workflow', 'workflowEnv', `env:\n  ${key}: ${value}`],
      ['job', 'jobEnv', `    env:\n      ${key}: ${value}`],
      ['step', 'step', `        env:\n          ${key}: ${value}`],
    ]) {
      const root = gatedRepo({ [field]: envBlock, run: 'node --test scripts/a.test.js' });
      assertUnrun(root, `${scope} ${key}`);
    }

    const root = gatedRepo({
      workflowEnv: `env:\n  ${key}: ${value}`,
      jobEnv: `    env:\n      ${key}: ${value}`,
      step: `        env:\n          ${key}: ''`,
      run: 'node --test scripts/a.test.js',
    }, { 'scripts/a.test.js': MARKER_TEST });
    if (key === 'NODE_TEST_CONTEXT') {
      const control = bashStep(root, 'node --test scripts/a.test.js', { NODE_TEST_CONTEXT: '' });
      assert.equal(control.child.status, 0, `FIXTURE_ERROR empty step NODE_TEST_CONTEXT: ${control.child.stdout}${control.child.stderr}`);
      assert.equal(fs.existsSync(control.marker), false, 'defined empty NODE_TEST_CONTEXT reached marker');
      assertUnrun(root, 'empty step NODE_TEST_CONTEXT overrides inherited value but still suppresses collection');
    } else {
      const control = bashStep(root, 'node --test scripts/a.test.js', { NODE_OPTIONS: '' });
      assert.equal(control.child.status, 0, `FIXTURE_ERROR empty step NODE_OPTIONS: ${control.child.stdout}${control.child.stderr}`);
      assert.equal(fs.existsSync(control.marker), true, 'empty step NODE_OPTIONS did not clear inherited filter');
      assertRun(root, 'empty step NODE_OPTIONS override');
    }
  }
});

test('any defined NODE_TEST_CONTEXT suppresses direct test collection', async (t) => {
  const run = 'node --test scripts/a.test.js';
  const cases = [
    {
      name: 'step empty',
      spec: { step: "        env:\n          NODE_TEST_CONTEXT: ''", run },
      inherited: { NODE_TEST_CONTEXT: '' },
    },
    { name: 'export empty', spec: { run: `export NODE_TEST_CONTEXT=\n${run}` } },
    { name: 'inline empty', spec: { run: `NODE_TEST_CONTEXT= ${run}` } },
    {
      name: 'empty step overrides workflow child',
      spec: {
        workflowEnv: 'env:\n  NODE_TEST_CONTEXT: child',
        step: "        env:\n          NODE_TEST_CONTEXT: ''",
        run,
      },
      inherited: { NODE_TEST_CONTEXT: '' },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => assertBashSuppressed(item.spec, item.name, item.inherited));
  }
});

test('NODE_OPTIONS test-shard filters do not count as complete test runs', async (t) => {
  const cases = [
    {
      name: 'step environment',
      spec: {
        step: '        env:\n          NODE_OPTIONS: --test-shard=2/2',
        run: 'node --test scripts/a.test.js',
      },
      inherited: { NODE_OPTIONS: '--test-shard=2/2' },
    },
    {
      name: 'inline environment',
      spec: { run: 'NODE_OPTIONS=--test-shard=2/2 node --test scripts/a.test.js' },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => assertBashSuppressed(item.spec, `NODE_OPTIONS test-shard ${item.name}`, item.inherited));
  }
});

test('NODE_OPTIONS filter option names with underscore or mixed separators block direct and runner coverage', async (t) => {
  const directCases = [
    {
      name: 'underscore skip-pattern',
      spec: { step: '        env:\n          NODE_OPTIONS: --test_skip_pattern=passes', run: 'node --test scripts/a.test.js' },
      inherited: { NODE_OPTIONS: '--test_skip_pattern=passes' },
    },
    {
      name: 'mixed skip-pattern',
      spec: { run: 'NODE_OPTIONS=--test-skip_pattern=passes node --test scripts/a.test.js' },
    },
    {
      name: 'underscore name-pattern',
      spec: { workflowEnv: 'env:\n  NODE_OPTIONS: --test_name_pattern=nomatch', run: 'node --test scripts/a.test.js' },
      inherited: { NODE_OPTIONS: '--test_name_pattern=nomatch' },
    },
    {
      name: 'mixed name-pattern',
      spec: { jobEnv: '    env:\n      NODE_OPTIONS: --test-name_pattern=nomatch', run: 'node --test scripts/a.test.js' },
      inherited: { NODE_OPTIONS: '--test-name_pattern=nomatch' },
    },
    {
      name: 'underscore shard',
      spec: { step: '        env:\n          NODE_OPTIONS: --test_shard=2/2', run: 'node --test scripts/a.test.js' },
      inherited: { NODE_OPTIONS: '--test_shard=2/2' },
    },
  ];
  for (const item of directCases) {
    await t.test(`direct ${item.name}`, () => assertBashSuppressed(item.spec, item.name, item.inherited, FAIL_MARKER_PASSES));
  }

  const runnerSource = fs.readFileSync(path.join(__dirname, 'run-module-tests.js'), 'utf8');
  const runnerCases = [
    ['underscore skip-pattern', '--test_skip_pattern=passes'],
    ['mixed skip-pattern', '--test-skip_pattern=passes'],
    ['underscore name-pattern', '--test_name_pattern=not-matching'],
    ['mixed name-pattern', '--test-name_pattern=not-matching'],
    ['underscore shard', '--test_shard=2/2'],
  ];
  for (const [name, filter] of runnerCases) {
    await t.test(`runner ${name}`, () => {
      const run = 'node scripts/run-module-tests.js scripts/a.test.js';
      const spec = { step: `        env:\n          NODE_OPTIONS: ${filter}`, run };
      const root = gatedRepo(spec, {
        'scripts/a.test.js': MARKER_TEST,
        'scripts/run-module-tests.js': runnerSource,
      });
      const { child, marker } = bashStep(root, run, { NODE_OPTIONS: filter });
      assert.equal(child.status, 2, `${name} runner should reject the filter: ${child.stdout}${child.stderr}`);
      assert.equal(fs.existsSync(marker), false, `${name} runner started the test child`);
      assert.match(child.stderr, /NODE_OPTIONS.*--test[-_]?(?:skip|name|shard)/i);
      assertUnrun(root, `runner ${name}`);
    });
  }
});

test('exported shell environment mutations persist and fail closed for direct tests', async (t) => {
  const cases = [
    {
      name: 'standalone reassignment keeps inherited NODE_OPTIONS exported',
      workflowEnv: 'env:\n  NODE_OPTIONS: --enable-source-maps',
      inherited: { NODE_OPTIONS: '--enable-source-maps' },
      run: 'NODE_OPTIONS=--test-skip-pattern=passes\nnode --test scripts/a.test.js',
    },
    {
      name: 'unsupported append to exported NODE_OPTIONS fails closed',
      workflowEnv: 'env:\n  NODE_OPTIONS: --enable-source-maps',
      inherited: { NODE_OPTIONS: '--enable-source-maps' },
      run: 'NODE_OPTIONS+=" --test-skip-pattern=passes"\nnode --test scripts/a.test.js',
    },
    {
      name: 'export append to inherited NODE_OPTIONS fails closed',
      workflowEnv: 'env:\n  NODE_OPTIONS: --enable-source-maps',
      inherited: { NODE_OPTIONS: '--enable-source-maps' },
      run: 'export NODE_OPTIONS+=" --test-skip-pattern=passes"\nnode --test scripts/a.test.js',
    },
    {
      name: 'unset -f leaves exported NODE_OPTIONS filter in place',
      workflowEnv: 'env:\n  NODE_OPTIONS: --test-skip-pattern=passes',
      inherited: { NODE_OPTIONS: '--test-skip-pattern=passes' },
      run: 'unset -f NODE_OPTIONS\nnode --test scripts/a.test.js',
    },
    {
      name: 'export NODE_OPTIONS assignment persists',
      run: 'export NODE_OPTIONS=--test-skip-pattern=passes\nnode --test scripts/a.test.js',
    },
    {
      name: 'export NODE_TEST_CONTEXT assignment persists',
      run: 'export NODE_TEST_CONTEXT=child\nnode --test scripts/a.test.js',
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const root = gatedRepo({ workflowEnv: item.workflowEnv || '', run: item.run }, { 'scripts/a.test.js': MARKER_TEST });
      const { child, marker } = bashStep(root, item.run, item.inherited);
      assert.equal(child.status, 0, `FIXTURE_ERROR ${item.name}: ${child.stdout}${child.stderr}`);
      assert.equal(fs.existsSync(marker), false, `FIXTURE_ERROR ${item.name}: Bash reached marker`);
      assertUnrun(root, item.name);
    });
  }
});

test('an assignment before export or unset leaves an exported filter in place in bash', async (t) => {
  const filter = '--test-skip-pattern=passes';
  const spec = (run) => ({ workflowEnv: `env:\n  NODE_OPTIONS: ${filter}`, run });
  for (const run of [
    'NODE_OPTIONS= export >/dev/null\nnode --test scripts/a.test.js',
    'NODE_OPTIONS= export FOO\nnode --test scripts/a.test.js',
    'NODE_OPTIONS= export -n NODE_OPTIONS\nnode --test scripts/a.test.js',
    'NODE_OPTIONS+=--enable-source-maps export FOO\nnode --test scripts/a.test.js',
    'NODE_OPTIONS= unset FOO\nnode --test scripts/a.test.js',
    'NODE_OPTIONS= unset NODE_OPTIONS\nnode --test scripts/a.test.js',
  ]) {
    await t.test(run, () => assertBashSuppressed(spec(run), run, { NODE_OPTIONS: filter }, FAIL_MARKER_PASSES));
  }

  await t.test('export naming the variable keeps the prefix value', () => {
    const filtered = 'NODE_OPTIONS=--test-skip-pattern=passes export NODE_OPTIONS\nnode --test scripts/a.test.js';
    assertBashSuppressed({ workflowEnv: 'env:\n  NODE_OPTIONS: --enable-source-maps', run: filtered }, filtered,
      { NODE_OPTIONS: '--enable-source-maps' }, FAIL_MARKER_PASSES);

    const benign = 'NODE_OPTIONS=--enable-source-maps export NODE_OPTIONS\nnode --test scripts/a.test.js';
    const root = gatedRepo(spec(benign), { 'scripts/a.test.js': MARKER_TEST });
    const control = bashStep(root, benign, { NODE_OPTIONS: filter });
    assert.equal(control.child.status, 0, `FIXTURE_ERROR named export: ${control.child.stdout}${control.child.stderr}`);
    assert.equal(fs.existsSync(control.marker), true, 'named export did not replace the inherited filter');
    assertRun(root, 'named export replaces the inherited filter');
  });

  await t.test('sh keeps the prefix assignment, so the verifier fails closed', () => {
    // dash persists an assignment before a special builtin and keeps its export attribute.
    const run = 'NODE_OPTIONS=--test-skip-pattern=passes export FOO\nnode --test scripts/a.test.js';
    const root = gatedRepo({ workflowEnv: 'env:\n  NODE_OPTIONS: --enable-source-maps', shell: '        shell: sh', run });
    assertUnrun(root, 'sh prefix before export');
  });
});

test('declare -x and typeset -x export a shell variable filter', async (t) => {
  for (const run of [
    'NODE_OPTIONS=--test-skip-pattern=passes\ndeclare -x NODE_OPTIONS\nnode --test scripts/a.test.js',
    'NODE_OPTIONS=--test-skip-pattern=passes\ntypeset -x NODE_OPTIONS\nnode --test scripts/a.test.js',
    'NODE_OPTIONS=--enable-source-maps\ndeclare -x NODE_OPTIONS+=" --test-skip-pattern=passes"\nnode --test scripts/a.test.js',
  ]) {
    await t.test(run, () => assertBashSuppressed({ run }, run, {}, FAIL_MARKER_PASSES));
  }
});

test('shell environment controls stay local, reset cleanly and do not cross steps', () => {
  const inheritedFilter = '--test-skip-pattern=passes';
  const ordinaryUnset = 'unset NODE_OPTIONS\nnode --test scripts/a.test.js';
  const ordinaryUnsetRoot = gatedRepo({
    workflowEnv: `env:\n  NODE_OPTIONS: ${inheritedFilter}`,
    run: ordinaryUnset,
  }, { 'scripts/a.test.js': MARKER_TEST });
  const ordinaryUnsetControl = bashStep(ordinaryUnsetRoot, ordinaryUnset, { NODE_OPTIONS: inheritedFilter });
  assert.equal(ordinaryUnsetControl.child.status, 0, `FIXTURE_ERROR ordinary unset: ${ordinaryUnsetControl.child.stdout}${ordinaryUnsetControl.child.stderr}`);
  assert.equal(fs.existsSync(ordinaryUnsetControl.marker), true, 'ordinary unset did not clear the exported filter');
  assertRun(ordinaryUnsetRoot, 'ordinary unset clears an exported filter');

  const localEmpty = 'NODE_OPTIONS= node --test scripts/a.test.js';
  const emptyRoot = gatedRepo({
    workflowEnv: `env:\n  NODE_OPTIONS: ${inheritedFilter}`,
    run: localEmpty,
  }, { 'scripts/a.test.js': MARKER_TEST });
  const emptyControl = bashStep(emptyRoot, localEmpty, { NODE_OPTIONS: inheritedFilter });
  assert.equal(emptyControl.child.status, 0, `FIXTURE_ERROR inline empty override: ${emptyControl.child.stdout}${emptyControl.child.stderr}`);
  assert.equal(fs.existsSync(emptyControl.marker), true, 'inline empty override did not reach marker');
  assertRun(emptyRoot, 'inline empty override');

  const localFilter = 'NODE_OPTIONS=--test-skip-pattern=passes node --test scripts/a.test.js\nnode --test scripts/a.test.js';
  const localRoot = gatedRepo({ run: localFilter }, { 'scripts/a.test.js': MARKER_TEST });
  const localControl = bashStep(localRoot, localFilter);
  assert.equal(localControl.child.status, 0, `FIXTURE_ERROR inline local assignment: ${localControl.child.stdout}${localControl.child.stderr}`);
  assert.equal(fs.existsSync(localControl.marker), true, 'inline assignment poisoned the following command');
  assertRun(localRoot, 'inline command-local filter');

  const beforeExport = 'NODE_OPTIONS=--test-skip-pattern=passes export\nnode --test scripts/a.test.js';
  const beforeExportRoot = gatedRepo({
    workflowEnv: 'env:\n  NODE_OPTIONS: --enable-source-maps',
    run: beforeExport,
  }, { 'scripts/a.test.js': MARKER_TEST });
  const beforeExportControl = bashStep(beforeExportRoot, beforeExport, { NODE_OPTIONS: '--enable-source-maps' });
  assert.equal(beforeExportControl.child.status, 0, `FIXTURE_ERROR assignment before export: ${beforeExportControl.child.stdout}${beforeExportControl.child.stderr}`);
  assert.equal(fs.existsSync(beforeExportControl.marker), true, 'assignment before export incorrectly reached child environment');
  assertRun(beforeExportRoot, 'assignment before export');

  const unexported = 'NODE_OPTIONS=--test-skip-pattern=passes\nnode --test scripts/a.test.js';
  const unexportedRoot = gatedRepo({ run: unexported }, { 'scripts/a.test.js': MARKER_TEST });
  const unexportedControl = bashStep(unexportedRoot, unexported);
  assert.equal(unexportedControl.child.status, 0, `FIXTURE_ERROR unexported assignment: ${unexportedControl.child.stdout}${unexportedControl.child.stderr}`);
  assert.equal(fs.existsSync(unexportedControl.marker), true, 'unexported shell variable leaked into child environment');
  assertRun(unexportedRoot, 'unexported assignment');

  const reset = 'export NODE_OPTIONS=--test-skip-pattern=passes\nexport NODE_OPTIONS=--enable-source-maps\nnode --test scripts/a.test.js';
  const resetRoot = gatedRepo({ run: reset }, { 'scripts/a.test.js': MARKER_TEST });
  const resetControl = bashStep(resetRoot, reset);
  assert.equal(resetControl.child.status, 0, `FIXTURE_ERROR exported reset: ${resetControl.child.stdout}${resetControl.child.stderr}`);
  assert.equal(fs.existsSync(resetControl.marker), true, 'later benign export did not reach marker');
  assertRun(resetRoot, 'later benign export');

  const emptyReset = 'export NODE_OPTIONS=--test-skip-pattern=passes\nexport NODE_OPTIONS=\nnode --test scripts/a.test.js';
  const emptyResetRoot = gatedRepo({ run: emptyReset }, { 'scripts/a.test.js': MARKER_TEST });
  const emptyResetControl = bashStep(emptyResetRoot, emptyReset);
  assert.equal(emptyResetControl.child.status, 0, `FIXTURE_ERROR empty exported reset: ${emptyResetControl.child.stdout}${emptyResetControl.child.stderr}`);
  assert.equal(fs.existsSync(emptyResetControl.marker), true, 'empty export did not clear the prior filter');
  assertRun(emptyResetRoot, 'empty exported reset');

  const contextUnexported = 'NODE_TEST_CONTEXT=child\nnode --test scripts/a.test.js';
  const contextUnexportedRoot = gatedRepo({ run: contextUnexported }, { 'scripts/a.test.js': MARKER_TEST });
  const contextUnexportedControl = bashStep(contextUnexportedRoot, contextUnexported);
  assert.equal(contextUnexportedControl.child.status, 0, `FIXTURE_ERROR unexported NODE_TEST_CONTEXT: ${contextUnexportedControl.child.stdout}${contextUnexportedControl.child.stderr}`);
  assert.equal(fs.existsSync(contextUnexportedControl.marker), true, 'unexported NODE_TEST_CONTEXT reached child environment');
  assertRun(contextUnexportedRoot, 'unexported NODE_TEST_CONTEXT assignment');

  const acrossSteps = repo({
    '.github/workflows/ci.yml': workflow(['export NODE_OPTIONS=--test-skip-pattern=passes', 'node --test scripts/a.test.js']),
    'scripts/a.test.js': MARKER_TEST,
    [INVENTORY]: EMPTY_INVENTORY,
  });
  const first = bashStep(acrossSteps, 'export NODE_OPTIONS=--test-skip-pattern=passes');
  const second = bashStep(acrossSteps, 'node --test scripts/a.test.js');
  assert.equal(first.child.status, 0, `FIXTURE_ERROR first step: ${first.child.stdout}${first.child.stderr}`);
  assert.equal(second.child.status, 0, `FIXTURE_ERROR next step: ${second.child.stdout}${second.child.stderr}`);
  assert.equal(fs.existsSync(second.marker), true, 'exported variable leaked across workflow steps');
  assertRun(acrossSteps, 'workflow step environment is isolated');
});

test('false-or adjacency and the module runner environment positive controls remain green', () => {
  const run = 'true || node --test scripts/a.test.js\nnode --test scripts/a.test.js';
  const root = gatedRepo({ run }, { 'scripts/a.test.js': MARKER_TEST });
  const control = bashStep(root, run);
  assert.equal(control.child.status, 0, `FIXTURE_ERROR false-or control: ${control.child.stdout}${control.child.stderr}`);
  assert.equal(fs.existsSync(control.marker), true, 'reachable test after false-or did not reach marker');
  assertRun(root, 'false-or adjacency');

  const runnerTest = [
    "require('node:test')('runner environment', () => {",
    "  if (process.env.NODE_OPTIONS !== '--enable-source-maps') throw new Error('benign NODE_OPTIONS was lost');",
    "  require('node:fs').writeFileSync(process.env.MARKER, 'ran');",
    '});',
    '',
  ].join('\n');
  const runner = fs.readFileSync(path.join(REPO_ROOT, 'scripts/run-module-tests.js'), 'utf8');
  const runnerRun = 'node scripts/run-module-tests.js scripts/a.test.js';
  const runnerRoot = gatedRepo({
    step: '        env:\n          NODE_OPTIONS: --enable-source-maps\n          NODE_TEST_CONTEXT: child',
    run: runnerRun,
  }, { 'scripts/a.test.js': runnerTest, 'scripts/run-module-tests.js': runner });
  const runnerControl = bashStep(runnerRoot, runnerRun, {
    NODE_OPTIONS: '--enable-source-maps', NODE_TEST_CONTEXT: 'child',
  });
  assert.equal(runnerControl.child.status, 0, `FIXTURE_ERROR runner control: ${runnerControl.child.stdout}${runnerControl.child.stderr}`);
  assert.equal(fs.existsSync(runnerControl.marker), true, 'module runner failed to clear child context or preserve benign options');
  assertRun(runnerRoot, 'runner benign options and context clearing');
});

test('conditional exit commands do not mask reachable later tests', async (t) => {
  for (const run of [
    'echo prep || exit 1\nnode --test scripts/a.test.js',
    'if [ -n "$NOPE" ]; then exit 0; fi\nnode --test scripts/a.test.js',
  ]) {
    await t.test(run, () => {
      const passingRoot = gatedRepo({ run }, { 'scripts/a.test.js': MARKER_TEST });
      const passing = bashStep(passingRoot, run);
      assert.equal(passing.child.status, 0, `FIXTURE_ERROR ${run} passing Bash: ${passing.child.stdout}${passing.child.stderr}`);
      assert.equal(fs.existsSync(passing.marker), true, `FIXTURE_ERROR ${run} passing Bash did not reach marker`);

      const failingRoot = gatedRepo({ run }, { 'scripts/a.test.js': FAIL_MARKER_TEST });
      const failing = bashStep(failingRoot, run);
      assert.equal(failing.child.status, 1, `FIXTURE_ERROR ${run} failing Bash: ${failing.child.stdout}${failing.child.stderr}`);
      assert.equal(fs.existsSync(failing.marker), true, `FIXTURE_ERROR ${run} failing Bash did not reach marker`);
      assertRun(passingRoot, `conditional exit: ${run}`);
    });
  }
});

test('pipefail, shell: bash and a final && list keep the exit status', () => {
  for (const spec of [
    { run: 'set -o pipefail\nnode --test scripts/a.test.js | tee out.txt' },
    { run: 'set -euo pipefail\nnode --test scripts/a.test.js 2>&1 | tee out.txt' },
    { shell: '        shell: bash', run: 'node --test scripts/a.test.js | tee out.txt' },
    { run: 'echo start\nnode --test scripts/a.test.js && echo done' },
    { run: 'false || node --test scripts/a.test.js' },
    { run: 'set +e\nset -e\nnode --test scripts/a.test.js' },
    { run: 'echo x | node --test scripts/a.test.js' },
  ]) {
    const root = gatedRepo(spec);
    assert.deepEqual(verify(root).errors, [], JSON.stringify(spec));
    assert.equal(inventoryCli(root).status, 0, JSON.stringify(spec));
  }
});

test('a set -e that may not run in this shell keeps exit on error off', async (t) => {
  // OSI_FIXTURE_ERREXIT is unset, so none of these resets runs in the step's shell.
  for (const run of [
    'set +e; if [ -n "$OSI_FIXTURE_ERREXIT" ]; then set -e; fi; node --test scripts/a.test.js; echo done',
    'set +e\n[ -n "$OSI_FIXTURE_ERREXIT" ] && set -e\nnode --test scripts/a.test.js\necho done',
    'set +e\n[ -z "$OSI_FIXTURE_ERREXIT" ] || set -e\nnode --test scripts/a.test.js\necho done',
    'set +e\n[ -n "$OSI_FIXTURE_ERREXIT" ] && { set -e; }\nnode --test scripts/a.test.js\necho done',
    'set +e\nwhile [ -n "$OSI_FIXTURE_ERREXIT" ]; do set -e; break; done\nnode --test scripts/a.test.js\necho done',
    'set +e\nfor f in $OSI_FIXTURE_ERREXIT; do\nset -e\ndone\nnode --test scripts/a.test.js\necho done',
    'set +e\ncase "$OSI_FIXTURE_ERREXIT" in\nyes)\nset -e ;;\nesac\nnode --test scripts/a.test.js\necho done',
    'set +e\nenable_errexit() {\nset -e\n}\nnode --test scripts/a.test.js\necho done',
    'set +e\n(set -e)\nnode --test scripts/a.test.js\necho done',
    'set +e\nignored=$(set -e)\nnode --test scripts/a.test.js\necho done',
    'set +e\necho x | set -e\nnode --test scripts/a.test.js\necho done',
  ]) {
    await t.test(run, () => assertBashMasksFailure({ run }, run));
  }

  const plainReset = 'set +e\necho prep; set -e\nnode --test scripts/a.test.js';
  const plainRoot = gatedRepo({ run: plainReset }, { 'scripts/a.test.js': FAIL_MARKER_TEST });
  const plain = bashStep(plainRoot, plainReset);
  assert.equal(plain.child.status, 1, `FIXTURE_ERROR plain reset: ${plain.child.stdout}${plain.child.stderr}`);
  assertRun(plainRoot, 'unconditional set -e after ;');
});

test('an if after else, elif, then or do nests until its own fi', async (t) => {
  for (const run of [
    'set +e\nif true; then :; else if false; then :; fi\nset -e\nfi\nnode --test scripts/a.test.js\necho done',
    'set +e\nif true; then :; else while false; do if true; then :; fi; done\nset -e\nfi\nnode --test scripts/a.test.js\necho done',
  ]) {
    await t.test(run, () => assertBashMasksFailure({ run }, run));
  }
  const unreachable = 'if false; then\nfor x in a; do if true; then :; fi; done\nnode --test scripts/a.test.js\nfi\necho done';
  await t.test(unreachable, () => assertBashSuppressed({ run: unreachable }, unreachable));
});

test('an environment change that may not run in this shell makes the variable unknown', async (t) => {
  // OSI_FIXTURE_NEVER is unset, so none of these changes runs in the step's shell.
  const filter = '--test-skip-pattern=passes';
  const inherited = { workflowEnv: `env:\n  NODE_OPTIONS: ${filter}` };
  for (const [spec, env] of [
    [{ run: `export NODE_OPTIONS=${filter}\nif [ -n "$OSI_FIXTURE_NEVER" ]; then\n  NODE_OPTIONS= export NODE_OPTIONS\nfi\nnode --test scripts/a.test.js` }, {}],
    [{ run: `export NODE_OPTIONS=${filter}\nreset_filter() {\n  NODE_OPTIONS= export NODE_OPTIONS\n}\nnode --test scripts/a.test.js` }, {}],
    [{ run: `export NODE_OPTIONS=${filter}\nif [ -n "$OSI_FIXTURE_NEVER" ]; then export NODE_OPTIONS=; fi\nnode --test scripts/a.test.js` }, {}],
    [{ ...inherited, run: '[ -n "$OSI_FIXTURE_NEVER" ] && export NODE_OPTIONS=\nnode --test scripts/a.test.js' }, { NODE_OPTIONS: filter }],
    [{ ...inherited, run: 'if [ -n "$OSI_FIXTURE_NEVER" ]; then unset NODE_OPTIONS; fi\nnode --test scripts/a.test.js' }, { NODE_OPTIONS: filter }],
    [{ ...inherited, run: 'if [ -n "$OSI_FIXTURE_NEVER" ]; then NODE_OPTIONS=; fi\nnode --test scripts/a.test.js' }, { NODE_OPTIONS: filter }],
    [{ ...inherited, run: 'echo x | export NODE_OPTIONS=\nnode --test scripts/a.test.js' }, { NODE_OPTIONS: filter }],
    [{ ...inherited, run: '(export NODE_OPTIONS=)\nnode --test scripts/a.test.js' }, { NODE_OPTIONS: filter }],
  ]) {
    await t.test(spec.run, () => assertBashSuppressed(spec, spec.run, env, FAIL_MARKER_PASSES));
  }
});

test('after the first compound or grouping construct no shell state change holds', async (t) => {
  // OSI_FIXTURE_NEVER is unset. Case labels end in ) and may look like keywords.
  const filter = '--test-skip-pattern=passes';
  for (const run of [
    'set +e\n(\ncase x in\nx) :;;\nesac\nset -e\n)\nnode --test scripts/a.test.js\necho done',
    'set +e\nif [ -n "$OSI_FIXTURE_NEVER" ]; then\ncase x in\nfi) :;;\nesac\nset -e\nfi\nnode --test scripts/a.test.js\necho done',
  ]) {
    await t.test(run, () => assertBashMasksFailure({ run }, run));
  }
  for (const run of [
    `export NODE_OPTIONS=${filter}\n(\ncase x in\nx) :;;\nesac\nNODE_OPTIONS= export NODE_OPTIONS\n)\nnode --test scripts/a.test.js`,
    `export NODE_OPTIONS=${filter}\nif [ -n "$OSI_FIXTURE_NEVER" ]; then\ncase x in\nfi) :;;\nesac\nNODE_OPTIONS= export NODE_OPTIONS\nfi\nnode --test scripts/a.test.js`,
  ]) {
    await t.test(run, () => assertBashSuppressed({ run }, run, {}, FAIL_MARKER_PASSES));
  }
  for (const run of [
    'case x in\nif) :;;\nesac\nexit 0\nnode --test scripts/a.test.js',
    'if false; then\ny=$(if true; then :; fi)\nnode --test scripts/a.test.js\nfi',
  ]) {
    await t.test(run, () => assertBashSuppressed({ run }, run));
  }

  for (const [run, inherited] of [
    ['set +e\necho prep\nset -e\nnode --test scripts/a.test.js', {}],
    [`export NODE_OPTIONS=${filter}\nexport NODE_OPTIONS=--enable-source-maps\nnode --test scripts/a.test.js`, {}],
    ['NODE_OPTIONS=\nunset NODE_OPTIONS\nnode --test scripts/a.test.js', { NODE_OPTIONS: filter }],
  ]) {
    await t.test(`top level: ${run}`, () => {
      const spec = { workflowEnv: inherited.NODE_OPTIONS ? `env:\n  NODE_OPTIONS: ${filter}` : '', run };
      const root = gatedRepo(spec, { 'scripts/a.test.js': MARKER_TEST });
      const control = bashStep(root, run, inherited);
      assert.equal(control.child.status, 0, `FIXTURE_ERROR ${run}: ${control.child.stdout}${control.child.stderr}`);
      assert.equal(fs.existsSync(control.marker), true, `FIXTURE_ERROR ${run}: Bash did not reach marker`);
      assertRun(root, run);
    });
  }
});

test('other builtins that write a tracked variable make it unknown', async (t) => {
  const benign = '--enable-source-maps';
  for (const run of [
    'builtin export NODE_OPTIONS=--test-skip-pattern=passes\nnode --test scripts/a.test.js',
    'command export NODE_OPTIONS=--test-skip-pattern=passes\nnode --test scripts/a.test.js',
    'printf -v NODE_OPTIONS %s --test-skip-pattern=passes\nnode --test scripts/a.test.js',
    'read -r NODE_OPTIONS < opts.txt\nnode --test scripts/a.test.js',
  ]) {
    await t.test(run, () => {
      const spec = { workflowEnv: `env:\n  NODE_OPTIONS: ${benign}`, run };
      const extra = { 'opts.txt': '--test-skip-pattern=passes\n', 'scripts/a.test.js': MARKER_TEST };
      const passingRoot = gatedRepo(spec, extra);
      const passing = bashStep(passingRoot, run, { NODE_OPTIONS: benign });
      assert.equal(passing.child.status, 0, `FIXTURE_ERROR ${run}: ${passing.child.stdout}${passing.child.stderr}`);
      assert.equal(fs.existsSync(passing.marker), false, `FIXTURE_ERROR ${run}: Bash reached marker`);
      const failingRoot = gatedRepo(spec, { ...extra, 'scripts/a.test.js': FAIL_MARKER_PASSES });
      const failing = bashStep(failingRoot, run, { NODE_OPTIONS: benign });
      assert.equal(failing.child.status, 0, `FIXTURE_ERROR ${run} failing: ${failing.child.stdout}${failing.child.stderr}`);
      assertUnrun(passingRoot, run);
    });
  }
});

test('non-executing and filtering node options do not run the test', () => {
  for (const [run, reason] of [
    ['node --check scripts/a.test.js', /--check/],
    ['node -c scripts/a.test.js', /-c/],
    ['node --test --test-name-pattern=nothing scripts/a.test.js', /--test-name-pattern/],
    ['node --test --test-skip-pattern=x scripts/a.test.js', /--test-skip-pattern/],
    ['node --test --test-only scripts/a.test.js', /--test-only/],
  ]) {
    const errors = errorsOf(gatedRepo({ run }));
    assert.match(errors, NOT_RUN, run);
    assert.match(errors, reason, run);
  }
});

test('a test file passed as an argument to another script is not run', () => {
  for (const run of ['node scripts/other.js scripts/a.test.js', 'sh scripts/other.sh scripts/a.test.js']) {
    const errors = errorsOf(gatedRepo({ run }, { 'scripts/other.sh': 'true\n' }));
    assert.match(errors, NOT_RUN, run);
    assert.match(errors, /passed as an argument to scripts\/other\.(js|sh)/, run);
  }
});

test('a bash script started with sh fails, because sh is dash on the runner', () => {
  const extra = { 'scripts/b.test.sh': '#!/usr/bin/env bash\nset -euo pipefail\n', 'scripts/p.test.sh': '#!/bin/sh\ntrue\n' };
  const bad = errorsOf(gatedRepo({ run: 'node --test scripts/a.test.js\nsh scripts/b.test.sh' }, extra));
  assert.match(bad, /scripts\/b\.test\.sh: a bash script \(shebang .*bash\) run with sh/);
  const ok = gatedRepo({ run: 'node --test scripts/a.test.js\nbash scripts/b.test.sh\nsh scripts/p.test.sh' }, extra);
  assert.deepEqual(verify(ok).errors, []);
});

test('the module-test runner remains covered under a step child context', () => {
  const root = gatedRepo({
    step: '        env:\n          NODE_TEST_CONTEXT: child',
    run: 'node scripts/run-module-tests.js scripts/a.test.js',
  }, { 'scripts/run-module-tests.js': '' });
  assert.deepEqual(verify(root).errors, []);
  assert.equal(inventoryCli(root).status, 0);
});

test('the runner and --no-warnings still mark tests as run', () => {
  for (const run of ['node scripts/run-module-tests.js scripts/a.test.js', 'node --no-warnings scripts/a.test.js', 'node scripts/a.test.js']) {
    assert.deepEqual(verify(gatedRepo({ run }, { 'scripts/run-module-tests.js': '' })).errors, [], run);
  }
});

test('the two pull-request conditions in use count as running', () => {
  const spec = {
    job: "    if: github.repository == 'Open-Smart-Irrigation/osi-os'",
    step: "        if: github.event_name == 'pull_request'",
    run: 'node --test scripts/a.test.js',
  };
  assert.deepEqual(verify(gatedRepo(spec)).errors, []);
});

test('conditions and shells the verifier cannot judge fail closed and name the step', () => {
  for (const [spec, re] of [
    [{ step: "        if: github.ref == 'refs/heads/main'", run: 'node --test scripts/a.test.js' }, /ci\.yml: job check step 2: cannot decide whether if: github\.ref/],
    [{ job: '    if: always()', run: 'node --test scripts/a.test.js' }, /job check step 2: cannot decide whether if: always\(\)/],
    [{ step: '        continue-on-error: ${{ matrix.experimental }}', run: 'node --test scripts/a.test.js' }, /cannot decide whether continue-on-error/],
    [{ shell: '        shell: pwsh', run: 'node --test scripts/a.test.js' }, /shell pwsh is not modelled/],
    [{ run: 'set +e\nnode --test scripts/a.test.js' }, /set \+e/],
    [{ run: 'node --require ./hook.js scripts/a.test.js' }, /node option --require is not modelled/],
  ]) {
    assert.match(errorsOf(gatedRepo(spec)), re, JSON.stringify(spec));
  }
});

test('a runner named only in a step that cannot fail does not count for indirect tests', () => {
  const root = gatedRepo({ step: '        continue-on-error: true', run: 'node scripts/umbrella.js' }, {
    'scripts/umbrella.js': '// runs test-chained.js\n',
    'scripts/test-chained.js': PASSING,
    [INVENTORY]: JSON.stringify({ excluded: [{ path: 'scripts/a.test.js', reason: 'not wired in this fixture' }], indirect: [{ path: 'scripts/test-chained.js', runner: 'scripts/umbrella.js' }] }),
  });
  assert.match(errorsOf(root), /scripts\/test-chained\.js: runner scripts\/umbrella\.js is not run by any workflow/);
});

test('exclusions of failing or slow tests must cite an issue', () => {
  const files = { '.github/workflows/ci.yml': workflow(['node --test scripts/a.test.js']), 'scripts/a.test.js': PASSING, 'scripts/b.test.js': PASSING, 'scripts/c.test.js': PASSING };
  const bad = repo({ ...files, [INVENTORY]: JSON.stringify({ indirect: [], excluded: [
    { path: 'scripts/b.test.js', reason: 'fails on main: something is broken' },
    { path: 'scripts/c.test.js', reason: 'slow: takes twenty minutes' },
  ] }) });
  const errors = errorsOf(bad);
  assert.match(errors, /scripts\/b\.test\.js: a "fails on main" or "slow" exclusion needs an issue reference/);
  assert.match(errors, /scripts\/c\.test\.js: a "fails on main" or "slow" exclusion needs an issue reference/);
  const ok = repo({ ...files, [INVENTORY]: JSON.stringify({ indirect: [], excluded: [
    { path: 'scripts/b.test.js', reason: 'fails on main: something is broken (#12)' },
    { path: 'scripts/c.test.js', reason: 'slow: takes twenty minutes, see #34' },
  ] }) });
  assert.deepEqual(verify(ok).errors, []);
});

test('a workflow that cannot be parsed or has an unusable step fails closed', () => {
  const bad = repo({
    '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - name: nothing to do\n',
    '.github/workflows/broken.yml': 'jobs: {a: 1}\n',
    'scripts/a.test.js': PASSING,
    [INVENTORY]: EMPTY_INVENTORY,
  });
  const errors = errorsOf(bad);
  assert.match(errors, /ci\.yml: job a step 1 has neither run nor uses/);
  assert.match(errors, /broken\.yml: .*flow mapping/);
});

test('a missing or malformed inventory fails closed', () => {
  const base = { '.github/workflows/ci.yml': workflow(['node --test scripts/a.test.js']), 'scripts/a.test.js': PASSING };
  assert.match(errorsOf(repo(base)), /verify-test-inventory\.json: cannot read/);
  assert.match(errorsOf(repo({ ...base, [INVENTORY]: '{' })), /verify-test-inventory\.json: not valid JSON/);
  assert.match(errorsOf(repo({ ...base, [INVENTORY]: JSON.stringify({ excluded: [], indirect: [], extra: 1 }) })), /unknown key "extra"/);
});

test('no workflow directory fails closed', () => {
  const root = repo({ 'scripts/a.test.js': PASSING, [INVENTORY]: EMPTY_INVENTORY });
  assert.match(errorsOf(root), /no workflow files/);
});

test('the CLI exits 1 with the problems and 0 when clean', () => {
  const bad = repo({
    '.github/workflows/ci.yml': workflow(['node --test scripts/a.test.js']),
    'scripts/a.test.js': PASSING,
    'scripts/b.test.js': PASSING,
    [INVENTORY]: EMPTY_INVENTORY,
  });
  const r = spawnSync(process.execPath, [SCRIPT, `--root=${bad}`], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /scripts\/b\.test\.js: no workflow runs this test/);
  assert.match(r.stderr, /verify-test-inventory: FAIL/);
});

test('this repository passes', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /verify-test-inventory: OK/);
});
