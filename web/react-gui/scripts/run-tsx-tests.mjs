#!/usr/bin/env node
// Runs `tsx --test` on the files the given glob patterns match, relative to
// the working directory, and fails before running anything when a pattern
// matches no file. `tsx --test 'tests/**/*.test.ts'` on its own exits 0 with
// zero tests once the directory moves.
//
// Each file gets a time limit (default 120 s; RUN_TSX_TESTS_TIMEOUT_MS to
// change it). A file that runs past it is stopped and reported as failed under
// its own name with "test timed out", so a hang fails the run instead of
// holding it until the CI job limit (#393). The same limit applies to each
// single test inside the files.
//
// Usage: node scripts/run-tsx-tests.mjs '<pattern>' ['<pattern>' ...]
// Quote the patterns so the shell does not expand them.
// scripts/verify-test-inventory.js at the repository root reads the patterns
// from package.json to check that every GUI test file is collected.
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 120_000;

const patterns = process.argv.slice(2);
if (!patterns.length) {
  console.error('run-tsx-tests: no patterns given');
  process.exit(2);
}

const timeoutSetting = process.env.RUN_TSX_TESTS_TIMEOUT_MS;
const timeoutMs = timeoutSetting === undefined || timeoutSetting === '' ? DEFAULT_TIMEOUT_MS : Number(timeoutSetting);
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
  console.error(`run-tsx-tests: RUN_TSX_TESTS_TIMEOUT_MS must be a positive whole number of milliseconds, got '${timeoutSetting}'`);
  process.exit(2);
}

const files = new Set();
const problems = [];
for (const pattern of patterns) {
  if (pattern.startsWith('-')) {
    problems.push(`${pattern}: options are not allowed`);
    continue;
  }
  const hits = globSync(pattern).filter((f) => !f.split(path.sep).includes('node_modules'));
  if (!hits.length) problems.push(`${pattern} matches no file`);
  for (const f of hits.sort()) files.add(f);
}
if (problems.length) {
  for (const p of problems) console.error(`run-tsx-tests: ${p}`);
  console.error('run-tsx-tests: FAIL (nothing was run)');
  process.exit(2);
}

console.log(`run-tsx-tests: ${files.size} test files, time limit ${timeoutMs} ms per file`);
const tsx = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'tsx');
// Started from inside another node:test run, `node --test` sees
// NODE_TEST_CONTEXT, skips every file and exits 0.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const r = spawnSync(tsx, ['--test', `--test-timeout=${timeoutMs}`, ...files], { stdio: 'inherit', env });
if (r.error) {
  console.error(`run-tsx-tests: could not start tsx: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
