import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import {relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import inventory from '../../../scripts/verify-test-inventory.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const {isTestFile} = inventory;
const executedStatuses = new Set(['passed', 'failed', 'timedOut']);
const normalize = path => path.split(sep).join('/');

function options(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = args.slice(i, i + 2);
    if (!['--results', '--files', '--e2e'].includes(flag) || flags[flag] || !value || value.startsWith('-')) {
      throw new Error('usage: verify-test-coverage.mjs [--results <path>] [--files <dir>] [--e2e <path>]');
    }
    flags[flag] = resolve(value);
  }
  return flags;
}

function testFiles(directory, fixtureMode) {
  const files = fixtureMode
    ? readdirSync(directory, {recursive: true, withFileTypes: true})
        .filter(entry => entry.isFile())
        .map(entry => normalize(relative(directory, resolve(entry.parentPath, entry.name))))
    : execFileSync('git', ['ls-files', '-z', '--', '.'], {cwd: directory, encoding: 'utf8'}).split('\0');
  return [...new Set(files.filter(isTestFile))].sort();
}

function isPlaywrightSpec(file) {
  return /\.spec\.(c|m)?[jt]sx?$/.test(file)
    || (file.startsWith('tests/e2e/') && /\.test\.(c|m)?[jt]sx?$/.test(file));
}

function readE2e(path, directory) {
  const {config, suites} = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof config?.rootDir !== 'string' || !config.rootDir || !Array.isArray(suites)) {
    throw new Error('invalid Playwright JSON report');
  }

  const executed = new Set();
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      if (spec.tests.some(test => test.results.some(result => executedStatuses.has(result.status)))) {
        executed.add(normalize(relative(directory, resolve(config.rootDir, spec.file))));
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of suites) visit(suite);
  return executed;
}

function main() {
  const flags = options(process.argv.slice(2));
  const directory = flags['--files'] ?? packageRoot;
  const files = testFiles(directory, Boolean(flags['--files']));
  if (!files.length) throw new Error('no test files found');

  const results = JSON.parse(readFileSync(flags['--results'] ?? resolve(packageRoot, 'test-results/unit-files.json'), 'utf8'));
  if (!results || Array.isArray(results) || typeof results !== 'object') throw new Error('invalid unit file report');

  const specs = files.filter(isPlaywrightSpec);
  const e2ePath = flags['--e2e'] ?? (!flags['--files'] && specs.length ? resolve(packageRoot, 'test-results/e2e.json') : null);
  const executedSpecs = e2ePath ? readE2e(e2ePath, directory) : new Set();
  const missing = files.filter(file => {
    if (e2ePath && isPlaywrightSpec(file)) return !executedSpecs.has(file);
    const count = results[file];
    return !Object.hasOwn(results, file) || !Number.isSafeInteger(count) || count < 1;
  });

  if (missing.length) {
    for (const file of missing) console.error('verify-test-coverage: no executed test in ' + file);
    process.exitCode = 1;
    return;
  }
  console.log(`verify-test-coverage: OK (${files.length} test files)`);
}

try {
  main();
} catch (error) {
  console.error('verify-test-coverage: ' + error.message);
  process.exitCode = 1;
}
