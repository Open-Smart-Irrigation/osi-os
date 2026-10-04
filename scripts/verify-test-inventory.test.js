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

function gated({ on = '  pull_request:\n    branches: [ main ]', job = '', step = '', run, shell = '' }) {
  return [
    'name: Gated',
    'on:',
    on,
    'jobs:',
    '  check:',
    '    runs-on: ubuntu-latest',
    job,
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

test('pipefail, shell: bash and a final && list keep the exit status', () => {
  for (const spec of [
    { run: 'set -o pipefail\nnode --test scripts/a.test.js | tee out.txt' },
    { run: 'set -euo pipefail\nnode --test scripts/a.test.js 2>&1 | tee out.txt' },
    { shell: '        shell: bash', run: 'node --test scripts/a.test.js | tee out.txt' },
    { run: 'echo start\nnode --test scripts/a.test.js && echo done' },
    { run: 'false || node --test scripts/a.test.js' },
    { run: 'echo x | node --test scripts/a.test.js' },
  ]) {
    assert.deepEqual(verify(gatedRepo(spec)).errors, [], JSON.stringify(spec));
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
