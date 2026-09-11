'use strict';
// osi-os#212: reference-based grace path layered after osi-os#153's
// isPureNormalizerSchemeUpgrade check. Root cause (verified against a
// byte-copy of the live kaba100 farming.db, pre-restamp, 2026-09-11): the
// legacy sync-init-fn boot node re-creates ~20 trigger names it shares with
// the ordered migrations on every Node-RED start, substituting this
// gateway's real gateway_device_eui for the migration-baked fallback literal
// and reformatting the SQL as a compact single-line JS template literal.
// `deploy.sh` stamps fingerprints right after the migration runner commits
// (Node-RED stopped); the very next Node-RED start rewrites those triggers,
// so the NEXT `applyPending`/`verifyHead` sees a stamped-vs-live mismatch
// that survives even the v2/v3 normalizer-scheme-upgrade check, because that
// check is a pure hash-scheme comparison, not a reference-based one. There is
// no parity gap on main between sync-init-fn's literal and the migrations —
// `node scripts/verify-trigger-body-parity.js` already passes at HEAD — the
// gap is purely in the RUNNER's drift check, which this closes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cliRunner } = require('../runner-iface');
const {
  applyPending, verifyHead, isBootOwnedTriggerBodyDrift, maxAppliedVersion,
} = require('../runner');

const REPO = path.resolve(__dirname, '../../..');
const REAL_MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-boot-grace-'));
  const dir = path.join(root, 'm');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__a.sql'),
    '-- risk: additive\n'
    + 'CREATE TABLE devices (deveui TEXT PRIMARY KEY, gateway_device_eui TEXT);\n'
    + "CREATE TRIGGER trg_boot_owned AFTER UPDATE ON devices BEGIN SELECT 1; END;\n"
    + "CREATE TRIGGER trg_also_migration_owned AFTER INSERT ON devices BEGIN SELECT 1; END;\n");
  return { db: path.join(root, 't.db'), dir };
}

test('unit: maxAppliedVersion ignores failed/repair_required rows and returns 0 for none applied', () => {
  assert.equal(maxAppliedVersion([]), 0);
  assert.equal(maxAppliedVersion([{ version: 5, status: 'applied' }, { version: 3, status: 'applied' }]), 5);
  assert.equal(maxAppliedVersion([{ version: 9, status: 'failed' }, { version: 2, status: 'applied' }]), 2);
});

test('(ii) a genuinely altered TABLE (extra column) is still refused, even though a trigger also differs', async () => {
  const { db, dir } = fixture();
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' }); // stamps the healthy schema

  // Simulate the boot-node rewrite of trg_boot_owned (tolerable on its own)...
  await r.exec('DROP TRIGGER trg_boot_owned; CREATE TRIGGER trg_boot_owned AFTER UPDATE ON devices BEGIN SELECT 2; END;');
  // ...ALONGSIDE real out-of-band schema drift (an extra column) that the
  // reference-based check must never launder just because a trigger diff is
  // ALSO present in the same drift window.
  await r.exec('ALTER TABLE devices ADD COLUMN sneaky INTEGER;');

  const v = await verifyHead(r, { migrationsDir: dir });
  assert.equal(v.ok, false, 'a real table/column change must still refuse the reference-based grace path');
  assert.match(v.reason, /drift/i);

  await assert.rejects(
    applyPending(r, { migrationsDir: dir, appVersion: 'x' }),
    /drift/i,
    'applyPending must also refuse, not silently restamp past real column drift');
});

test('(iii) a genuinely altered non-boot-owned trigger is still refused', async () => {
  const { db, dir } = fixture();
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' });

  // Boot-node rewrite of the tolerated trigger...
  await r.exec('DROP TRIGGER trg_boot_owned; CREATE TRIGGER trg_boot_owned AFTER UPDATE ON devices BEGIN SELECT 2; END;');
  // ...but trg_also_migration_owned is NOT in the (test-injected) boot-owned
  // set below, standing in for a real migration-exclusive trigger
  // (verify-runtime-schema-parity.js's MIGRATION_OWNED_TRIGGERS map) whose
  // body changed out of band. The synthetic fixture's trigger names cannot
  // appear in that real, hardcoded, production-named map, so this test
  // exercises the same code path via isBootOwnedTriggerBodyDrift's
  // test-only bootOwnedTriggerNames override rather than end-to-end through
  // applyPending/verifyHead's production default.
  await r.exec('DROP TRIGGER trg_also_migration_owned; CREATE TRIGGER trg_also_migration_owned AFTER INSERT ON devices BEGIN SELECT 99; END;');

  const appliedHead = maxAppliedVersion(await r.all('SELECT version, status FROM schema_migrations'));
  const toleratesOnlyBootOwned = await isBootOwnedTriggerBodyDrift(
    r, dir, appliedHead, { bootOwnedTriggerNames: new Set(['trg_boot_owned']) });
  assert.equal(toleratesOnlyBootOwned, false,
    'a non-boot-owned trigger body change must not be tolerated even when a boot-owned trigger also legitimately differs');

  // Full-stack sanity: applyPending/verifyHead never pass bootOwnedTriggerNames,
  // so they always take the PRODUCTION default path -- and that default only
  // activates for the real, shipped database/migrations/ordered directory
  // (see runner.js's REAL_MIGRATIONS_DIR comment: the MIGRATION_OWNED_TRIGGERS
  // carve-out is only proven complete against the real seed/migrations, not an
  // arbitrary synthetic fixture dir like this one). So against this fixture's
  // own migrationsDir, the production default must refuse to even try the
  // tolerant path and fall through to the ordinary refusal -- exactly the
  // behavior that keeps runner-fingerprint-scheme-upgrade.test.js's
  // "not a pure scheme upgrade" case refused.
  const v = await verifyHead(r, { migrationsDir: dir });
  assert.equal(v.ok, false, 'production default must refuse for a non-real migrationsDir, not silently tolerate any trigger rewrite');
});

test('(i) a byte-copy of the live kaba100 farming.db (pre-restamp, v2-stamped, boot-rewritten triggers) passes the grace path and applies pending migrations 31-53', { timeout: 480_000 }, async () => {
  const fixturePath = path.join(REPO, 'lib/osi-migrate/__tests__/fixtures/kaba100-pre-restamp.db');
  if (!fs.existsSync(fixturePath)) {
    // The real byte-copy is large and gateway-specific; it is not committed to
    // the repo. Skip gracefully outside the environment that has it staged
    // (see the PR body / execution report for the live run's actual output).
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-kaba100-'));
  const work = path.join(root, 'farming.db');
  fs.copyFileSync(fixturePath, work);
  const r = cliRunner(work);

  const before = await verifyHead(r, { migrationsDir: REAL_MIGRATIONS_DIR });
  assert.equal(before.ok, false, 'sanity: the pre-restamp copy must actually look drifted before the grace path runs');

  const res = await applyPending(r, { migrationsDir: REAL_MIGRATIONS_DIR, appVersion: 'test-kaba100-grace', writersStopped: true });
  assert.ok(res.applied.length > 0, 'must apply the pending migrations, not just restamp');
  assert.deepEqual(res.applied, Array.from({ length: 53 - 30 }, (_, i) => 31 + i));

  const after = await verifyHead(r, { migrationsDir: REAL_MIGRATIONS_DIR });
  assert.deepEqual(after, { ok: true });
});
