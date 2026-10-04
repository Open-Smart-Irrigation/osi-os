#!/usr/bin/env node
'use strict';
// Runs an explicit list of node:test files under `node --test` and fails
// before running anything when the list is empty or names a file that does
// not exist.
//
// `node --test` treats each argument as a glob pattern. A pattern that
// matches nothing is skipped silently: `node --test 'dir/*.test.js'` exits 0
// with zero tests when the directory moved, and
// `node --test a.test.js renamed.test.js` exits 0 after running only
// a.test.js. A workflow step that lists its test files through this runner
// goes red instead.
//
// Usage: node scripts/run-module-tests.js <test file> [<test file> ...]
// Paths are relative to the working directory. Globs, directories and
// options are rejected. The environment is passed through unchanged.
// scripts/verify-test-inventory.js checks that every test file in the
// repository is run by a workflow step or excluded with a reason.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GLOB_CHARS = /[*?[\]{}]/;

function checkTestFiles(files, cwd) {
  const errors = [];
  if (!files.length) return ['no test files given; list each test file explicitly'];
  const seen = new Set();
  for (const file of files) {
    if (file.startsWith('-')) {
      errors.push(`${file}: options are not allowed; list test files only`);
      continue;
    }
    if (GLOB_CHARS.test(file)) {
      errors.push(`${file}: glob patterns are not allowed; list each test file`);
      continue;
    }
    const resolved = path.resolve(cwd, file);
    if (seen.has(resolved)) {
      errors.push(`${file}: listed twice`);
      continue;
    }
    seen.add(resolved);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      errors.push(`${file}: file not found`);
      continue;
    }
    if (!stat.isFile()) errors.push(`${file}: not a regular file`);
  }
  return errors;
}

function main(args, cwd) {
  const errors = checkTestFiles(args, cwd);
  if (errors.length) {
    for (const e of errors) console.error(`run-module-tests: ${e}`);
    console.error(`run-module-tests: FAIL (${errors.length} problems; nothing was run)`);
    return 2;
  }
  console.log(`run-module-tests: ${args.length} test files`);
  // Started from inside another node:test run, `node --test` sees
  // NODE_TEST_CONTEXT, prints a warning, skips every file and exits 0.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', ...args], { cwd, env, stdio: 'inherit' });
  if (r.error) {
    console.error(`run-module-tests: could not start node --test: ${r.error.message}`);
    return 1;
  }
  if (r.status === null) {
    console.error(`run-module-tests: node --test ended by signal ${r.signal}`);
    return 1;
  }
  return r.status;
}

if (require.main === module) process.exit(main(process.argv.slice(2), process.cwd()));

module.exports = { checkTestFiles, main };
