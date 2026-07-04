'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPending, verifyHead, readStoredFingerprints, sortFps } = require('../runner');
const { computeFingerprints } = require('../fingerprints');
const { cliRunner } = require('../runner-iface');

// Regression: a partial-batch failure must NOT wedge the retry. When an earlier
// migration in a batch commits and a later one fails, the committed migration's
// schema must already be stamped, so the retry's drift preflight passes.
test('partial-batch failure leaves committed migrations stamped; retry is not blocked as drift', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-'));
  const dir = path.join(root, 'm');
  fs.mkdirSync(dir);
  const db = path.join(root, 't.db');
  const r = cliRunner(db);

  // Deploy 1: 0001 applies + stamps (establishes a non-empty baseline).
  fs.writeFileSync(path.join(dir, '0001__a.sql'), '-- risk: additive\nCREATE TABLE a (id INTEGER PRIMARY KEY);\n');
  await applyPending(r, { migrationsDir: dir, appVersion: 'v1' });
  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, true);

  // Deploy 2: 0002 valid, 0003 invalid. 0002 commits, 0003 fails pre-commit.
  fs.writeFileSync(path.join(dir, '0002__b.sql'), '-- risk: additive\nCREATE TABLE b (id INTEGER PRIMARY KEY);\n');
  fs.writeFileSync(path.join(dir, '0003__bad.sql'), '-- risk: additive\nCREATE TABLE c (id INTEGER PRIMARY KEY);\nNOT VALID SQL;\n');
  await assert.rejects(applyPending(r, { migrationsDir: dir, appVersion: 'v2' }));

  // The committed 0002 must already be stamped (live == stored) so the retry preflight passes.
  const stored = await readStoredFingerprints(r);
  const live = sortFps(await computeFingerprints(r));
  assert.strictEqual(JSON.stringify(stored), JSON.stringify(live),
    'committed 0002 must be stamped after the partial failure');

  // Deploy 2 RETRY (0003 fixed): must succeed WITHOUT a manual restamp.
  fs.writeFileSync(path.join(dir, '0003__bad.sql'), '-- risk: additive\nCREATE TABLE c (id INTEGER PRIMARY KEY);\n');
  const res = await applyPending(r, { migrationsDir: dir, appVersion: 'v2' });
  assert.deepStrictEqual(res.applied, [3], 'retry applies only the previously-failed 0003');
  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, true);
});
