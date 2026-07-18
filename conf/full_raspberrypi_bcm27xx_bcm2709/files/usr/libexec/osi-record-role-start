#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const sourceHelper = path.join(__dirname, 'current-role-state.js');
const residentHelper = path.join(__dirname, 'osi-current-role-state');
const roleState = require(fs.existsSync(sourceHelper) ? sourceHelper : residentHelper);

// Commit-1 primitive only. Commit 4 must invoke this recorder for every
// managed-role process start (and establish the first current-boot event)
// before current-role-state becomes an activated production dependency.

function main(argv, options = {}) {
  if (argv.length !== 1) throw new Error('usage: osi-record-role-start <managed-role>');
  const event = roleState.recordRoleStart(argv[0], options);
  return { ok: true, role: event.role, bootId: event.bootId };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`[osi-record-role-start] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
