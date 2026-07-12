#!/usr/bin/env node
'use strict';
const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
const { applyPending } = require('../../lib/osi-migrate');

async function main() {
  const [dbPath, migrationsDir] = process.argv.slice(2);
  if (!dbPath || !migrationsDir) { console.error('usage: kill9-child.js <dbPath> <migrationsDir>'); process.exit(2); }
  process.send && process.send('applying');
  await applyPending(cliRunner(dbPath), { migrationsDir, appVersion: 'soak', writersStopped: true });
  process.send && process.send('done');
}

main().catch((e) => { console.error(`[kill9-child] ${e.message}`); process.exit(1); });
