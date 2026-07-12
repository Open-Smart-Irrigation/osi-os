'use strict';
// Stage 1 migrate-cli: persistent fsync'd backup before destructive/data apply,
// applyPending under writersStopped, and byte-image restore on failure.
// Spec: docs/superpowers/specs/2026-07-08-option-b-stage1-deploy-runner-design.md
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh, verifyHead } = require('../lib/osi-migrate');
const { runMigrateCli } = require('./migrate-cli');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migcli-'));
}

function migrationVersionsAfter(version) {
  return fs.readdirSync(MIGRATIONS_DIR)
    .map((name) => {
      const match = name.match(/^(\d{4})__/);
      return match ? Number(match[1]) : null;
    })
    .filter((n) => n !== null && n > version)
    .sort((a, b) => a - b);
}

test('device at head: no pending migrations, no persistent backup, applied empty', async () => {
  const dir = scratch();
  const db = path.join(dir, 'device.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: MIGRATIONS_DIR, appVersion: 'test' });
  const backupDir = path.join(dir, 'bak');
  const res = await runMigrateCli({ dbPath: db, backupDir, migrationsDir: MIGRATIONS_DIR, log: () => {} });
  assert.deepEqual(res.applied, []);
  assert.equal(res.offDeviceBackup, null);
  assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: MIGRATIONS_DIR }), { ok: true });
});

async function deviceAtV3(dir) {
  const sub = path.join(dir, 'm3');
  fs.mkdirSync(sub);
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    if (/^000[123]__/.test(f) || f === 'CHECKSUMS.json') {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(sub, f));
    }
  }
  const db = path.join(dir, 'device.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: sub, appVersion: 'baseline-existing-db' });
  return db;
}

test('pending destructive: persistent backup taken + fsync-verified, applies to head', async () => {
  const dir = scratch();
  const db = await deviceAtV3(dir);
  const backupDir = path.join(dir, 'bak');
  const res = await runMigrateCli({ dbPath: db, backupDir, migrationsDir: MIGRATIONS_DIR, log: () => {} });
  assert.deepEqual(res.applied, migrationVersionsAfter(3));
  assert.ok(res.offDeviceBackup && fs.existsSync(res.offDeviceBackup), 'persistent backup file must exist');
  const bakRows = await cliRunner(res.offDeviceBackup)
    .all("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1");
  assert.ok(bakRows.length >= 1);
  assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: MIGRATIONS_DIR }), { ok: true });
});

test('injected migration failure: byte-image restored, DB unchanged', async () => {
  const dir = scratch();
  const db = await deviceAtV3(dir);
  const backupDir = path.join(dir, 'bak');
  const poisoned = path.join(dir, 'poisoned');
  fs.mkdirSync(poisoned);
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(poisoned, f));
  }
  const bad = '-- risk: data\nPRAGMA foreign_keys=ON;\n'
    + "INSERT INTO device_data (deveui, recorded_at) VALUES ('NO_SUCH_DEVICE_EUI', '2020-01-01T00:00:00Z');\n";
  fs.writeFileSync(path.join(poisoned, '0008__bad.sql'), bad);
  const manifest = JSON.parse(fs.readFileSync(path.join(poisoned, 'CHECKSUMS.json'), 'utf8'));
  const crypto = require('node:crypto');
  manifest['0008__bad.sql'] = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(poisoned, '0008__bad.sql')))
    .digest('hex');
  fs.writeFileSync(path.join(poisoned, 'CHECKSUMS.json'), JSON.stringify(manifest, null, 2) + '\n');

  const before = fs.readFileSync(db);
  const res = await runMigrateCli({ dbPath: db, backupDir, migrationsDir: poisoned, log: () => {} })
    .catch((e) => ({ error: e }));
  assert.ok(res.error, 'expected the run to throw after restoring');
  const integrity = await cliRunner(db).all('PRAGMA integrity_check');
  assert.equal(integrity[0].integrity_check || 'ok', 'ok');
  assert.ok(before.equals(fs.readFileSync(db)), 'DB must be byte-restored to pre-migration image');
});

test('refuses a missing db path', async () => {
  await assert.rejects(
    () => runMigrateCli({
      dbPath: '/nonexistent/nope.db',
      backupDir: scratch(),
      migrationsDir: MIGRATIONS_DIR,
      log: () => {},
    }),
    /does not exist/
  );
});

test('refuses a missing backup-dir argument', async () => {
  const dir = scratch();
  const db = path.join(dir, 'd.db');
  await cliRunner(db).exec('CREATE TABLE x (a TEXT);');
  await assert.rejects(
    () => runMigrateCli({ dbPath: db, backupDir: null, migrationsDir: MIGRATIONS_DIR, log: () => {} }),
    /backup-dir/
  );
});
