'use strict';
// osi-os#153 backward compatibility: bumping fingerprints.js's NORMALIZER_VERSION
// (2 -> 3, to make fingerprints blind to the gateway-EUI literal and to SQL
// token spacing) changes every stored fingerprint hash, because the scheme
// tag is baked into the hash itself. A DB whose schema_object_fingerprints
// were stamped by the pre-fix runner must not spuriously read as "drifted"
// merely because the hash scheme advanced.
//
// Two scenarios, both exercised against the real runner (applyPending /
// verifyHead), not a mock:
//  1. Pure scheme upgrade (nothing about the live schema changed since the
//     old stamp — the realistic window between `deploy.sh` migrating and
//     Node-RED's next restart). This MUST self-heal with zero operator
//     action: verifyHead returns {ok:true} and re-stamps under the new
//     scheme; applyPending's drift preflight does not refuse a pending
//     migration either.
//  2. Not a pure scheme upgrade: the old stamp was already stale versus live
//     for a reason the new scheme also cannot paper over blindly (simulated
//     here as an out-of-band DDL change after the v2 stamp, standing in for
//     "this gateway's boot node had already rewritten its own EUI into the
//     trigger before the fix shipped"). This MUST still refuse, with an
//     actionable message pointing at `restamp-fingerprints.js`, and MUST
//     recover cleanly once that sanctioned tool is run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cliRunner } = require('../runner-iface');
const { applyPending, verifyHead, syncFingerprints, composeFingerprintRefresh, sortFps, readStoredFingerprints } = require('../runner');
const { computeFingerprints, PREVIOUS_NORMALIZER_VERSION, NORMALIZER_VERSION } = require('../fingerprints');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-scheme-'));
  const dir = path.join(root, 'm'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__a.sql'),
    "-- risk: additive\nCREATE TABLE devices (deveui TEXT PRIMARY KEY, gateway_device_eui TEXT);\n"
    + "CREATE TRIGGER trg_a AFTER UPDATE ON devices BEGIN SELECT 1; END;\n");
  return { db: path.join(root, 't.db'), dir };
}

// Overwrite schema_object_fingerprints with what the OLD (v2) runner would
// have stamped for the CURRENT live schema — i.e. simulate "this DB was last
// touched by the pre-osi-os#153-fix runner".
async function restampUnderOldScheme(runner) {
  // Guard against this test degenerating into a no-op: on the pre-fix runner
  // PREVIOUS_NORMALIZER_VERSION does not exist and computeFingerprints()
  // silently ignores its second argument, which would make every assertion
  // below trivially true for the wrong reason (there being only one scheme).
  assert.equal(typeof PREVIOUS_NORMALIZER_VERSION, 'number', 'fingerprints.js must export a numeric PREVIOUS_NORMALIZER_VERSION');
  assert.equal(typeof NORMALIZER_VERSION, 'number');
  assert.notEqual(PREVIOUS_NORMALIZER_VERSION, NORMALIZER_VERSION, 'sanity: versions must differ for this test to mean anything');
  const oldFps = await computeFingerprints(runner, { normalizerVersion: PREVIOUS_NORMALIZER_VERSION });
  const newFps = sortFps(await computeFingerprints(runner));
  assert.notEqual(JSON.stringify(sortFps(oldFps)), JSON.stringify(newFps),
    'computeFingerprints(..., {normalizerVersion}) must actually take effect, not be ignored');
  await runner.exec(composeFingerprintRefresh(oldFps));
}

test('pure scheme upgrade: unchanged live schema, stored under v2 -> verifyHead self-heals to ok:true', async () => {
  const { db, dir } = fixture();
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' }); // stamps under CURRENT (v3) scheme
  await restampUnderOldScheme(r); // now looks like a pre-fix-era stamp; live schema untouched since

  const v1 = await verifyHead(r, { migrationsDir: dir });
  assert.deepEqual(v1, { ok: true }, 'a mere normalizer-scheme bump with no real schema change must not read as drift');

  // Confirm the self-heal actually re-stamped under the CURRENT scheme (not left at v2):
  // a second verifyHead must also pass without needing to re-run the heal path,
  // and the stored rows must now equal a fresh v3 computation exactly.
  const stored = await readStoredFingerprints(r);
  const freshV3 = sortFps(await computeFingerprints(r));
  assert.deepEqual(stored, freshV3, 'schema_object_fingerprints must now hold v3-scheme hashes');
  assert.deepEqual(await verifyHead(r, { migrationsDir: dir }), { ok: true });

  // And a pending migration is not blocked by the old stamp either (applyPending's
  // own preflight must self-heal the same way, not just verifyHead's).
  fs.writeFileSync(path.join(dir, '0002__b.sql'), '-- risk: additive\nCREATE TABLE t2 (id INTEGER PRIMARY KEY);\n');
  await restampUnderOldScheme(r); // re-simulate a v2-era stamp against the (still 0001-only) live schema
  const res = await applyPending(r, { migrationsDir: dir, appVersion: 'x' });
  assert.deepEqual(res.applied, [2], 'applyPending must apply the pending migration, not refuse on the scheme bump alone');
});

test('not a pure scheme upgrade: v2 stamp does not match live even under v2 rules -> refuses with an actionable message, recovers via restamp-fingerprints.js', async () => {
  const { db, dir } = fixture();
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' });
  await restampUnderOldScheme(r); // v2-era stamp, matching live AT THIS POINT

  // Simulate the real osi-os#153 shape: an out-of-band change to live schema
  // after the v2 stamp was taken (stands in for the boot node rewriting a
  // trigger's baked EUI literal with this gateway's own EUI before the fix
  // shipped — from the runner's point of view it is just "live no longer
  // matches what was stamped, under EITHER scheme").
  await r.exec('DROP TRIGGER trg_a; CREATE TRIGGER trg_a AFTER UPDATE ON devices BEGIN SELECT 2; END;');

  const v = await verifyHead(r, { migrationsDir: dir });
  assert.equal(v.ok, false, 'a real change layered on top of an old stamp must still be refused, not silently blessed');
  assert.match(v.reason, /restamp-fingerprints\.js/, 'the refusal must name the sanctioned recovery tool');

  execFileSync('node', [path.join(__dirname, '../../../scripts/restamp-fingerprints.js'), db], { encoding: 'utf8' });
  assert.deepEqual(await verifyHead(r, { migrationsDir: dir }), { ok: true }, 'restamp-fingerprints.js must fully recover verifyHead');
});

test('unit: isPureNormalizerSchemeUpgrade is exercised (not vacuous) — a genuinely v3-stamped DB with real drift stays refused', async () => {
  const { db, dir } = fixture();
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' }); // stamped under v3 already, no scheme gap at all
  await r.exec('ALTER TABLE devices ADD COLUMN sneaky INTEGER;');
  const v = await verifyHead(r, { migrationsDir: dir });
  assert.equal(v.ok, false);
  assert.match(v.reason, /drift/i);
});
