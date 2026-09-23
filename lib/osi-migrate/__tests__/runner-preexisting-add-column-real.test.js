'use strict';

// Real-corpus regression for osi-os#314. Start from the ordered baseline,
// apply exactly the versions in the affected gateway ledger, and create the
// valve-control schema that its frozen boot node had already installed. This
// then exercises 0022/0025 against their original SQL bytes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cliRunner, nodeSqliteRunner } = require('../runner-iface');
const { applyPending, bootstrapFresh, verifyHead } = require('../index');
const { getApplied } = require('../ledger');
const { syncFingerprints } = require('../runner');

const REPO = path.resolve(__dirname, '../../..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const LEDGER_VERSIONS = new Set([
  ...Array.from({ length: 21 }, (_, i) => i + 1),
  26, 27, 28, 29,
  ...Array.from({ length: 23 }, (_, i) => i + 31),
]);

async function affectedGatewayFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-real-add-column-'));
  const db = path.join(root, 'farming.db');
  const selectedDir = path.join(root, 'applied-migrations');
  fs.mkdirSync(selectedDir);
  const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}__.*\.sql$/.test(name))
    .sort();
  const copySelected = (version) => {
    const name = migrationFiles.find((candidate) => Number(candidate.slice(0, 4)) === version);
    fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(selectedDir, name));
  };

  for (let version = 1; version <= 21; version += 1) copySelected(version);
  const setupRunner = nodeSqliteRunner(db);
  await bootstrapFresh(setupRunner, { migrationsDir: selectedDir, appVersion: 'hardware-ledger-fixture' });

  const valveMigration = fs.readFileSync(path.join(MIGRATIONS_DIR, '0022__valve_control.sql'), 'utf8');
  await setupRunner.exec(`${valveMigration}\nALTER TABLE valve_settings ADD COLUMN sync_version INTEGER DEFAULT 0;`);
  await syncFingerprints(setupRunner);

  for (const version of [26, 27, 28, 29, ...Array.from({ length: 23 }, (_, i) => i + 31)]) {
    copySelected(version);
  }
  await applyPending(setupRunner, {
    migrationsDir: selectedDir,
    appVersion: 'hardware-ledger-fixture',
    writersStopped: true,
  });
  await setupRunner.close();

  const runner = cliRunner(db);
  await syncFingerprints(runner);
  return runner;
}

test('affected gateway ledger applies original pending migrations through 0059', { timeout: 900000 }, async () => {
  const runner = await affectedGatewayFixture();
  assert.deepEqual((await getApplied(runner)).map((row) => row.version), [...LEDGER_VERSIONS]);
  assert.equal((await runner.all("SELECT type FROM pragma_table_info('valve_actuation_expectations') WHERE name='trigger'"))[0].type, 'TEXT');
  assert.equal((await runner.all("SELECT type FROM sqlite_master WHERE type='table' AND name='valve_schedules'"))[0].type, 'table');
  assert.equal((await runner.all("SELECT type FROM sqlite_master WHERE type='table' AND name='valve_settings'"))[0].type, 'table');
  assert.deepEqual((await runner.all("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_valve_schedules_device','idx_valve_schedules_once_due','idx_valve_schedule_pushes_device_state') ORDER BY name")).map((row) => row.name), [
    'idx_valve_schedule_pushes_device_state', 'idx_valve_schedules_device', 'idx_valve_schedules_once_due',
  ]);

  const result = await applyPending(runner, {
    migrationsDir: MIGRATIONS_DIR,
    appVersion: 'real-add-column-test',
    writersStopped: true,
  });
  assert.deepEqual(result.applied, [22, 23, 24, 25, 30, 54, 55, 56, 57, 58, 59]);
  assert.deepEqual(await verifyHead(runner, { migrationsDir: MIGRATIONS_DIR }), { ok: true });
});

test('real 0022 refuses a preexisting trigger column with the wrong declared type', { timeout: 900000 }, async () => {
  const runner = await affectedGatewayFixture();
  const ddl = (await runner.all("SELECT sql FROM sqlite_master WHERE type='table' AND name='valve_actuation_expectations'"))[0].sql;
  const changed = ddl.replace('CREATE TABLE valve_actuation_expectations', 'CREATE TABLE valve_actuation_expectations_bad')
    .replace(/trigger TEXT\)?\s*$/i, 'trigger INTEGER)');
  assert.notEqual(changed, ddl);
  await runner.exec(`PRAGMA foreign_keys=OFF;
ALTER TABLE valve_actuation_expectations RENAME TO valve_actuation_expectations_old;
${changed};
INSERT INTO valve_actuation_expectations_bad SELECT * FROM valve_actuation_expectations_old;
DROP TABLE valve_actuation_expectations_old;
ALTER TABLE valve_actuation_expectations_bad RENAME TO valve_actuation_expectations;
PRAGMA foreign_keys=ON;`);
  await syncFingerprints(runner);
  await assert.rejects(
    () => applyPending(runner, { migrationsDir: MIGRATIONS_DIR, appVersion: 'real-add-column-conflict' }),
    /existing column valve_actuation_expectations\.trigger conflicts with ADD COLUMN definition/
  );
  assert.equal((await getApplied(runner)).find((row) => row.version === 22).status, 'failed');
});
