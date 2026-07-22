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

async function deviceAtVersion(dir, version) {
  const sub = path.join(dir, `m${version}`);
  fs.mkdirSync(sub);
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    const match = f.match(/^(\d{4})__/);
    if (match && Number(match[1]) <= version) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(sub, f));
    }
  }
  const db = path.join(dir, `device-v${version}.db`);
  await bootstrapFresh(cliRunner(db), { migrationsDir: sub, appVersion: 'baseline-existing-db' });
  return db;
}

async function deviceAtV3(dir) {
  return deviceAtVersion(dir, 3);
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

test('devices CHECK rebuild preserves child foreign keys when applying 0010', async () => {
  const dir = scratch();
  const db = await deviceAtVersion(dir, 9);
  const r = cliRunner(db);
  await r.exec(`
    PRAGMA foreign_keys=ON;
    INSERT INTO devices(deveui, name, type_id, created_at, updated_at)
    VALUES ('A84041DENDRO0001', 'Dendro fixture', 'DRAGINO_LSN50', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    INSERT INTO dendrometer_readings(deveui, position_um, recorded_at)
    VALUES ('A84041DENDRO0001', 1234.5, '2026-07-12T00:01:00.000Z');
  `);

  const backupDir = path.join(dir, 'bak');
  const res = await runMigrateCli({ dbPath: db, backupDir, migrationsDir: MIGRATIONS_DIR, log: () => {} });
  assert.deepEqual(res.applied, migrationVersionsAfter(9));
  assert.deepEqual(await cliRunner(db).all('PRAGMA foreign_key_check'), []);
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

function writeStalePremigrateFiles(backupDir, dbBasename, stamps) {
  fs.mkdirSync(backupDir, { recursive: true });
  for (const s of stamps) {
    fs.writeFileSync(path.join(backupDir, `${dbBasename}.premigrate-2020-01-${s}`), 'stale');
  }
}

// Retention only depends on needsBackup + keep + directory state, not on which
// migrations actually ran — so unlike the corpus-replay tests above (which
// exercise the real fingerprint machinery and are inherently slow, spawning a
// `sqlite3` subprocess per table/index per step), the retention tests use a
// tiny synthetic 2-migration corpus: bootstrap the device against a `sub` dir
// containing only the additive migration 0001, then hand runMigrateCli the
// full 2-migration dir so 0002 (risk: data) is the one pending migration —
// this makes needsBackup true cheaply, without replaying the real corpus.
async function deviceWithPendingDataMigration(dir) {
  const crypto = require('node:crypto');
  const migDir = path.join(dir, 'mig');
  fs.mkdirSync(migDir);
  const baseline = '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\n';
  const pending = '-- risk: data\nALTER TABLE t ADD COLUMN w TEXT;\n';
  fs.writeFileSync(path.join(migDir, '0001__baseline.sql'), baseline);
  fs.writeFileSync(path.join(migDir, '0002__addcol.sql'), pending);
  const manifest = {
    '0001__baseline.sql': crypto.createHash('sha256').update(baseline).digest('hex'),
    '0002__addcol.sql': crypto.createHash('sha256').update(pending).digest('hex'),
  };
  fs.writeFileSync(path.join(migDir, 'CHECKSUMS.json'), JSON.stringify(manifest, null, 2) + '\n');

  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  fs.copyFileSync(path.join(migDir, '0001__baseline.sql'), path.join(sub, '0001__baseline.sql'));
  fs.writeFileSync(
    path.join(sub, 'CHECKSUMS.json'),
    JSON.stringify({ '0001__baseline.sql': manifest['0001__baseline.sql'] }, null, 2) + '\n'
  );

  const db = path.join(dir, 'device.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: sub, appVersion: 'test' });
  return { db, migDir };
}

test('retention: destructive/data run prunes old .premigrate- backups to keep=N and never deletes the just-created one', async () => {
  const dir = scratch();
  const { db, migDir } = await deviceWithPendingDataMigration(dir);
  const backupDir = path.join(dir, 'bak');
  writeStalePremigrateFiles(backupDir, path.basename(db), ['01', '02', '03', '04', '05']);
  const prevKeep = process.env.MIGRATE_BACKUP_KEEP;
  process.env.MIGRATE_BACKUP_KEEP = '2';
  try {
    const res = await runMigrateCli({ dbPath: db, backupDir, migrationsDir: migDir, log: () => {} });
    assert.deepEqual(res.applied, [2]);
    const left = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith(`${path.basename(db)}.premigrate-`))
      .sort();
    assert.strictEqual(left.length, 2, 'only newest keep=2 survive');
    assert.ok(left.includes(path.basename(res.offDeviceBackup)), 'the just-created backup is always kept');
  } finally {
    if (prevKeep === undefined) delete process.env.MIGRATE_BACKUP_KEEP;
    else process.env.MIGRATE_BACKUP_KEEP = prevKeep;
  }
});

test('retention: the just-created backup survives even with MIGRATE_BACKUP_KEEP=0 or garbage (hard floor 1)', async () => {
  for (const badKeep of ['0', 'not-a-number', '-7']) {
    const dir = scratch();
    const { db, migDir } = await deviceWithPendingDataMigration(dir);
    const backupDir = path.join(dir, 'bak');
    writeStalePremigrateFiles(backupDir, path.basename(db), ['01', '02', '03']);
    const prevKeep = process.env.MIGRATE_BACKUP_KEEP;
    process.env.MIGRATE_BACKUP_KEEP = badKeep;
    try {
      const res = await runMigrateCli({ dbPath: db, backupDir, migrationsDir: migDir, log: () => {} });
      assert.ok(fs.existsSync(res.offDeviceBackup), `just-created backup must survive MIGRATE_BACKUP_KEEP=${badKeep}`);
    } finally {
      if (prevKeep === undefined) delete process.env.MIGRATE_BACKUP_KEEP;
      else process.env.MIGRATE_BACKUP_KEEP = prevKeep;
    }
  }
});

test('retention: runs on the !needsBackup (additive-only) path too, with no new backup created', async () => {
  const dir = scratch();
  const db = path.join(dir, 'device.db');
  const migDir = path.join(dir, 'mig');
  fs.mkdirSync(migDir);
  const baseline = '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\n';
  fs.writeFileSync(path.join(migDir, '0001__baseline.sql'), baseline);
  fs.writeFileSync(
    path.join(migDir, 'CHECKSUMS.json'),
    JSON.stringify({
      '0001__baseline.sql': require('node:crypto').createHash('sha256').update(baseline).digest('hex'),
    }, null, 2) + '\n'
  );
  await bootstrapFresh(cliRunner(db), { migrationsDir: migDir, appVersion: 'test' });
  const backupDir = path.join(dir, 'bak');
  writeStalePremigrateFiles(backupDir, path.basename(db), ['01', '02', '03', '04', '05']);
  const prevKeep = process.env.MIGRATE_BACKUP_KEEP;
  process.env.MIGRATE_BACKUP_KEEP = '2';
  try {
    const res = await runMigrateCli({ dbPath: db, backupDir, migrationsDir: migDir, log: () => {} });
    assert.deepEqual(res.applied, [], 'device already at head; nothing pending');
    assert.equal(res.offDeviceBackup, null, 'additive-only run creates no persistent backup');
    const left = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith(`${path.basename(db)}.premigrate-`))
      .sort();
    assert.strictEqual(left.length, 2, 'the pre-existing pile is trimmed to keep=2 even with no new backup');
  } finally {
    if (prevKeep === undefined) delete process.env.MIGRATE_BACKUP_KEEP;
    else process.env.MIGRATE_BACKUP_KEEP = prevKeep;
  }
});

test('--prune-only prunes the .premigrate- pile and does NOT back up or apply pending migrations', async () => {
  const dir = scratch();
  const { db, migDir } = await deviceWithPendingDataMigration(dir);
  const before = fs.readFileSync(db);
  const backupDir = path.join(dir, 'bak');
  writeStalePremigrateFiles(backupDir, path.basename(db), ['01', '02', '03', '04', '05']);
  const prevKeep = process.env.MIGRATE_BACKUP_KEEP;
  process.env.MIGRATE_BACKUP_KEEP = '2';
  try {
    const res = await runMigrateCli({
      dbPath: db, backupDir, migrationsDir: migDir, log: () => {}, pruneOnly: true,
    });
    assert.ok(res.pruned, 'prune-only reports it pruned');
    assert.deepEqual(res.applied, undefined, 'prune-only never applies migrations');
    assert.ok(before.equals(fs.readFileSync(db)), 'prune-only must not touch the DB at all');
    const left = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith(`${path.basename(db)}.premigrate-`))
      .sort();
    assert.strictEqual(left.length, 2, 'prune-only trims to keep=2');
    // Confirm nothing was actually applied: migration 0002 is still pending.
    const headCheck = await verifyHead(cliRunner(db), { migrationsDir: migDir });
    assert.equal(headCheck.ok, false, 'device must still be behind head after --prune-only');
  } finally {
    if (prevKeep === undefined) delete process.env.MIGRATE_BACKUP_KEEP;
    else process.env.MIGRATE_BACKUP_KEEP = prevKeep;
  }
});
