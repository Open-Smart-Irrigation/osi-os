#!/usr/bin/env node
'use strict';
const { syncFingerprints } = require('../lib/osi-migrate/runner');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');

async function main() {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('usage: restamp-fingerprints.js <path-to-farming.db>');
    console.error('Re-baselines schema_object_fingerprints to the CURRENT live schema.');
    console.error('Only run this after confirming the live schema is correct.');
    process.exit(2);
  }
  const runner = cliRunner(dbPath);
  console.error(`[restamp] re-baselining fingerprints for ${dbPath} to the current live schema`);
  await syncFingerprints(runner);
  console.error('[restamp] done. Run verifyHead to confirm ok:true.');
}
main().catch((e) => { console.error(`[restamp] FAILED: ${e.message}`); process.exit(1); });
