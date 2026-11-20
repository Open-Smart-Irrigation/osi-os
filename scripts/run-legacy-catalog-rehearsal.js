#!/usr/bin/env node
'use strict';
// A private PID namespace makes every fixture process inspectable through /proc.
// Keep the production tool's EACCES refusal unchanged.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = path.join(__dirname, 'rehearse-legacy-catalog.test.js');
let command = 'unshare';
let args = ['--pid', '--fork', '--mount-proc', process.execPath, '--test', test];
if (process.getuid() !== 0) {
  if (process.env.GITHUB_ACTIONS === 'true') { command = 'sudo'; args = ['-n', 'unshare', ...args]; }
  else args = ['--user', '--map-root-user', ...args];
}
const result = spawnSync(command, args, { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status === null ? 1 : result.status;
