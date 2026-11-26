import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const scripts = new URL('../../scripts/', import.meta.url);

test('coverage guard requires an executed test in every inventory file', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'farm-sim-coverage-'));
  try {
    const results = join(fixture, 'unit-files.json');
    const runnable = "import test from 'node:test';\ntest('runs', () => {});\n";
    const write = (file: string, text: string) => writeFileSync(join(fixture, file), text);
    const run = (script: string, ...args: string[]) => spawnSync(
      process.execPath, [fileURLToPath(new URL(script, scripts)), ...args], {cwd: fixture, encoding: 'utf8'},
    );
    const record = (...files: string[]) => {
      const result = run('run-tests.mjs', '--out', results, ...files);
      assert.equal(result.status, 0, result.stderr + result.stdout);
    };
    const verify = (...args: string[]) => run('verify-test-coverage.mjs', '--results', results, '--files', fixture, ...args);
    const missing = (...files: string[]) => {
      const result = verify();
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.deepEqual(result.stderr.trim().split('\n'), files.map(file => 'verify-test-coverage: no executed test in ' + file));
    };

    write('first.test.mjs', runnable);
    write('second.test.mjs', runnable);
    record('*.test.mjs');
    const complete = verify();
    assert.equal(complete.status, 0, complete.stderr);
    assert.match(complete.stdout, /OK \(2 test files\)/);

    record('first.test.mjs');
    missing('second.test.mjs');

    write('empty.test.mjs', '');
    write('inactive.test.mjs', [
      "import {describe, it} from 'node:test';",
      "describe('inactive suite', () => { it.skip('skipped', () => {}); it.todo('todo'); });",
    ].join('\n'));
    record('*.test.mjs');
    missing('empty.test.mjs', 'inactive.test.mjs');
    rmSync(join(fixture, 'empty.test.mjs'));
    rmSync(join(fixture, 'inactive.test.mjs'));

    write('browser.spec.ts', '');
    const e2e = join(fixture, 'e2e.json');
    const report = (status: string) => write('e2e.json', JSON.stringify({
      config: {rootDir: fixture},
      suites: [{specs: [], suites: [{specs: [{file: 'browser.spec.ts', tests: [{results: [{status}]}]}]}]}],
    }));
    report('skipped');
    const skipped = verify('--e2e', e2e);
    assert.equal(skipped.status, 1, skipped.stderr + skipped.stdout);
    assert.match(skipped.stderr, /no executed test in browser\.spec\.ts/);
    report('passed');
    const browserRan = verify('--e2e', e2e);
    assert.equal(browserRan.status, 0, browserRan.stderr);
    assert.match(browserRan.stdout, /OK \(3 test files\)/);
  } finally {
    rmSync(fixture, {recursive: true, force: true});
  }
});
