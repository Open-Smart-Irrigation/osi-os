'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { bootstrapFresh } = require('../index');
const { computeFingerprints } = require('../fingerprints');

const REPO = path.resolve(__dirname, '../../..');

test('empty DB + replay(migrations) fingerprints == empty DB + seed-blank.sql', async () => {
  const replayDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-rep-')), 'r.db');
  await bootstrapFresh(cliRunner(replayDb), {
    migrationsDir: path.join(REPO, 'database/migrations/ordered'), appVersion: 'test',
  });
  const seedDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-seed-')), 's.db');
  const seedR = cliRunner(seedDb);
  await seedR.exec(fs.readFileSync(path.join(REPO, 'database/seed-blank.sql'), 'utf8'));

  const repFps = await computeFingerprints(cliRunner(replayDb));
  const seedFps = await computeFingerprints(seedR);
  // schema_migrations / fingerprints tables exist only on the replay side; compare app tables/triggers.
  const appOnly = (xs) => xs.filter((x) => !['schema_migrations', 'schema_object_fingerprints'].includes(x.object_name));
  assert.deepEqual(appOnly(repFps), appOnly(seedFps));
});
