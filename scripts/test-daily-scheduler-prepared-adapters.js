#!/usr/bin/env node
'use strict';
// CI entry point for prepared-flow checks. Keep the preload in this driver:
// the workflow inventory intentionally rejects unmodelled Node CLI options.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const modes = {
  tests: [[ '--test',
    'scripts/test-scoped-access-writes.js',
    'scripts/test-request-context-isolation.js',
    'scripts/test-unified-soil-tension-scheduler.js',
    'scripts/test-chameleon-reading-link-ingest.js',
    'scripts/test-dendro-rolling-7d-rain.js',
  ]],
  guards: [
    ['scripts/verify-sync-flow.js'],
    ['scripts/verify-request-context-isolation.js'],
    ['scripts/verify-auth-flag-off-hermetic.js'],
    ['scripts/verify-lsn50-chameleon-swt.js'],
    ['scripts/test-conditional-irrigation-flow.js'],
  ],
};
const commands = modes[process.argv[2]];
assert.ok(commands && process.argv.length === 3, 'expected tests or guards');
for (const command of commands) {
  const run = spawnSync(process.execPath, [
    '--require', path.join(__dirname, 'lib/daily-scheduler-prepared-flow-hook.js'), ...command,
  ], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.status !== 0) { process.exitCode = run.status || 1; break; }
}
