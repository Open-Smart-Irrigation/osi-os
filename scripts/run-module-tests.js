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
// After the run it also fails when a listed file reported no test of its
// own (node --test counts such a file as one passing test) or when every
// test was skipped.
// scripts/verify-test-inventory.js checks that every test file in the
// repository is run by a workflow step or excluded with a reason.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

// Reads node --test's TAP output as it streams through and returns the
// files that reported no test of their own, plus the summary counts.
function tapSummary(lines, files) {
  const listed = new Set(files);
  const empty = [];
  const counts = {};
  for (const line of lines) {
    // A file without test() calls appears as one top-level test named by
    // its path; a file with tests appears through its tests.
    const m = /^ok \d+ - (.*)$/.exec(line);
    if (m && listed.has(m[1])) empty.push(m[1]);
    const c = /^# (tests|pass|fail|skipped|todo|cancelled) (\d+)$/.exec(line);
    if (c) counts[c[1]] = Number(c[2]);
  }
  return { empty, counts };
}

function main(args, cwd) {
  const errors = checkTestFiles(args, cwd);
  if (errors.length) {
    for (const e of errors) console.error(`run-module-tests: ${e}`);
    console.error(`run-module-tests: FAIL (${errors.length} problems; nothing was run)`);
    return Promise.resolve(2);
  }
  console.log(`run-module-tests: ${args.length} test files`);
  // Started from inside another node:test run, `node --test` sees
  // NODE_TEST_CONTEXT, prints a warning, skips every file and exits 0.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] });
    const kept = [];
    let partial = '';
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      const text = partial + chunk.toString('utf8');
      const lines = text.split('\n');
      partial = lines.pop();
      for (const line of lines) if (/^(ok \d+ - |# (tests|pass|fail|skipped|todo|cancelled) )/.test(line)) kept.push(line);
    });
    child.on('error', (err) => {
      console.error(`run-module-tests: could not start node --test: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) => {
      if (partial) kept.push(partial);
      if (code === null) {
        console.error(`run-module-tests: node --test ended by signal ${signal}`);
        resolve(1);
        return;
      }
      const { empty, counts } = tapSummary(kept, args);
      let status = code;
      for (const f of empty) {
        console.error(`run-module-tests: ${f} contains no tests`);
        status = status || 1;
      }
      if (counts.tests === undefined) {
        console.error('run-module-tests: node --test printed no summary');
        status = status || 1;
      } else if (counts.tests > 0 && (counts.skipped || 0) + (counts.todo || 0) >= counts.tests) {
        console.error('run-module-tests: every test was skipped');
        status = status || 1;
      }
      resolve(status);
    });
  });
}

if (require.main === module) main(process.argv.slice(2), process.cwd()).then((code) => process.exit(code));

module.exports = { checkTestFiles, tapSummary, main };
