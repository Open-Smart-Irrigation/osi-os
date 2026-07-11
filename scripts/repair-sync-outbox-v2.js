#!/usr/bin/env node
'use strict';
// Pre-baseline repair: add the sync_outbox v2 columns that are in
// seed-blank.sql / reference(1) but missing on pre-ledger gateways repaired
// before history-sync-v1.
//
// Not an ordered migration: 0001 already contains these columns, so no
// migration slot can express "add them to a pre-ledger DB".
// Temporary tool: delete once the fleet is baselined.
const fs = require('node:fs');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');

const COLUMNS = [
  ['rejected_at', 'TEXT'],
  ['rejection_reason', 'TEXT'],
  ['last_retryable_failure_at', 'TEXT'],
];

async function repairSyncOutboxV2(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`refusing: database file does not exist: ${dbPath}`);
  }
  const runner = cliRunner(dbPath);
  const before = await runner.all('PRAGMA table_xinfo(sync_outbox)');
  if (before.length === 0) {
    throw new Error('sync_outbox table missing entirely - that is the #87 whole-table gap, out of scope for this repair; refusing');
  }
  const have = new Set(before.map((r) => r.name));
  const added = [];
  for (const [name, type] of COLUMNS) {
    if (have.has(name)) continue;
    await runner.exec(`ALTER TABLE sync_outbox ADD COLUMN ${name} ${type};`);
    added.push(name);
  }
  const after = new Set((await runner.all('PRAGMA table_xinfo(sync_outbox)')).map((r) => r.name));
  for (const [name] of COLUMNS) {
    if (!after.has(name)) throw new Error(`sync_outbox.${name} still missing after repair`);
  }
  return { added };
}

async function main() {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('usage: repair-sync-outbox-v2.js <path-to-farming.db>');
    process.exit(2);
  }
  const { added } = await repairSyncOutboxV2(dbPath);
  console.error(added.length
    ? `[repair-sync-outbox-v2] added: ${added.join(', ')}`
    : '[repair-sync-outbox-v2] no-op: all three columns already present');
}

if (require.main === module) {
  main().catch((e) => { console.error(`[repair-sync-outbox-v2] FAILED: ${e.message}`); process.exit(1); });
}

module.exports = { repairSyncOutboxV2, COLUMNS };
