#!/usr/bin/env node
'use strict';
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../lib/osi-migrate');
const { computeFingerprints } = require('../lib/osi-migrate/fingerprints');

(async () => {
  const repo = path.resolve(__dirname, '..');
  const replayDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seedreplay-')), 'r.db');
  await bootstrapFresh(cliRunner(replayDb), { migrationsDir: path.join(repo, 'database/migrations/ordered'), appVersion: 'ci' });
  const seedDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seedreplay-')), 's.db');
  const seedR = cliRunner(seedDb);
  await seedR.exec(fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8'));
  const appOnly = (xs) => xs.filter((x) => !['schema_migrations', 'schema_object_fingerprints'].includes(x.object_name));
  const rep = appOnly(await computeFingerprints(cliRunner(replayDb)));
  const seed = appOnly(await computeFingerprints(seedR));
  if (JSON.stringify(rep) !== JSON.stringify(seed)) {
    console.error('FAIL: replay(migrations) != seed-blank.sql'); process.exit(1);
  }
  console.log('verify-seed-replay: OK'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
