'use strict';
// Issue #356: the durable link between a Chameleon diagnostic and the
// device_data row of the same uplink. Schema guarantees only; ingest and
// scheduler behaviour have their own tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { applyPending, bootstrapFresh, verifyHead } = require('../lib/osi-migrate');

const root = path.resolve(__dirname, '..');
const migrationsDir = path.join(root, 'database/migrations/ordered');
const EUI_A = 'A840410000000001';
const EUI_B = 'A840410000000002';
// chameleon_readings at f6682ef6. History sync sends SELECT * rows of this
// table, so a new column here would change the cloud payload.
const CHAMELEON_COLUMNS = [
  'id', 'deveui', 'recorded_at', 'payload_version', 'status_flags', 'i2c_missing', 'timeout',
  'temp_fault', 'id_fault', 'ch1_open', 'ch2_open', 'ch3_open', 'temp_c', 'r1_ohm_comp',
  'r2_ohm_comp', 'r3_ohm_comp', 'r1_ohm_raw', 'r2_ohm_raw', 'r3_ohm_raw', 'array_id', 'adc_ch0v',
  'adc_ch1v', 'adc_ch4v', 'bat_v', 'payload_b64', 'f_port', 'f_cnt', 'calibration_status',
  'data_invalid', 'comp_pending', 'created_at',
];

function migrationFile() {
  const names = fs.readdirSync(migrationsDir).filter((name) => /^\d{4}__chameleon_reading_links\.sql$/.test(name));
  assert.equal(names.length, 1, 'exactly one ordered chameleon_reading_links migration must exist');
  return names[0];
}

function seeded() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8'));
  db.exec('PRAGMA foreign_keys=ON');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  db.exec(`INSERT INTO devices (deveui,name,type_id,created_at,updated_at) VALUES
    ('${EUI_A}','Chameleon A','DRAGINO_LSN50','2026-10-28','2026-10-28'),
    ('${EUI_B}','Chameleon B','DRAGINO_LSN50','2026-10-28','2026-10-28')`);
  return db;
}

const canonical = (db, deveui, at) => Number(db.prepare(
  'INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, ?, 40) RETURNING id').get(deveui, at).id);
const diagnostic = (db, deveui, at) => Number(db.prepare(
  'INSERT INTO chameleon_readings (deveui, recorded_at, data_invalid) VALUES (?, ?, 0) RETURNING id').get(deveui, at).id);
const link = (db, readingId, dataId) => db.prepare(
  'INSERT INTO chameleon_reading_links (chameleon_reading_id, device_data_id) VALUES (?, ?)').run(readingId, dataId);
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('the ordered migration is additive and its bytes match CHECKSUMS.json', () => {
  const name = migrationFile();
  const raw = fs.readFileSync(path.join(migrationsDir, name));
  assert.ok(raw.toString('utf8').startsWith('-- risk: additive\n'));
  const manifest = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'CHECKSUMS.json'), 'utf8'));
  assert.equal(manifest[name], crypto.createHash('sha256').update(raw).digest('hex'));
});

test('fresh schema has the link table, its unique index and both guard triggers', () => {
  const db = seeded();
  try {
    assert.deepEqual(db.prepare('PRAGMA table_info(chameleon_reading_links)').all().map((c) => c.name),
      ['chameleon_reading_id', 'device_data_id', 'linked_at']);
    const index = db.prepare('PRAGMA index_list(chameleon_reading_links)').all()
      .find((row) => row.name === 'ux_chameleon_reading_links_device_data');
    assert.ok(index, 'ux_chameleon_reading_links_device_data must exist');
    assert.equal(index.unique, 1);
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='chameleon_reading_links' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(triggers, ['trg_chameleon_reading_links_identity_bi', 'trg_chameleon_reading_links_immutable_bu']);
    assert.deepEqual(db.prepare('PRAGMA table_info(chameleon_readings)').all().map((c) => c.name), CHAMELEON_COLUMNS);
  } finally { db.close(); }
});

test('one diagnostic links to one canonical row of the same device, once each way', () => {
  const db = seeded();
  try {
    const at = '2026-10-28T10:00:00.000Z';
    const data1 = canonical(db, EUI_A, at);
    const data2 = canonical(db, EUI_A, at);
    const reading1 = diagnostic(db, EUI_A, at);
    const reading2 = diagnostic(db, EUI_A, at);
    link(db, reading1, data1);
    assert.throws(() => link(db, reading2, data1), /UNIQUE constraint failed: chameleon_reading_links\.device_data_id/);
    assert.throws(() => link(db, reading1, data2), /UNIQUE constraint failed: chameleon_reading_links\.chameleon_reading_id/);
    link(db, reading2, data2);
    assert.deepEqual(db.prepare('SELECT chameleon_reading_id, device_data_id FROM chameleon_reading_links ORDER BY 1').all().map((r) => ({ ...r })),
      [{ chameleon_reading_id: reading1, device_data_id: data1 }, { chameleon_reading_id: reading2, device_data_id: data2 }]);
  } finally { db.close(); }
});

test('a cross-device or dangling link is refused', () => {
  const db = seeded();
  try {
    const at = '2026-10-28T10:00:00.000Z';
    const dataB = canonical(db, EUI_B, at);
    const readingA = diagnostic(db, EUI_A, at);
    assert.throws(() => link(db, readingA, dataB), /chameleon reading link must join rows of one device/);
    assert.throws(() => link(db, readingA, 999999), /chameleon reading link must join rows of one device/);
    assert.throws(() => link(db, 999999, dataB), /chameleon reading link must join rows of one device/);
    assert.equal(count(db, 'chameleon_reading_links'), 0);
  } finally { db.close(); }
});

test('a link is immutable', () => {
  const db = seeded();
  try {
    const at = '2026-10-28T10:00:00.000Z';
    const data1 = canonical(db, EUI_A, at);
    const data2 = canonical(db, EUI_A, at);
    const reading = diagnostic(db, EUI_A, at);
    link(db, reading, data1);
    assert.throws(() => db.prepare('UPDATE chameleon_reading_links SET device_data_id = ?').run(data2), /chameleon reading link is immutable/);
  } finally { db.close(); }
});

test('deleting either parent removes only the link, never the other measurement', () => {
  const db = seeded();
  try {
    const at = '2026-10-28T10:00:00.000Z';
    const data1 = canonical(db, EUI_A, at);
    const reading1 = diagnostic(db, EUI_A, at);
    link(db, reading1, data1);
    db.prepare('DELETE FROM device_data WHERE id = ?').run(data1);
    assert.equal(count(db, 'chameleon_reading_links'), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chameleon_readings WHERE id = ?').get(reading1).n, 1);

    const data2 = canonical(db, EUI_A, at);
    const reading2 = diagnostic(db, EUI_A, at);
    link(db, reading2, data2);
    db.prepare('DELETE FROM chameleon_readings WHERE id = ?').run(reading2);
    assert.equal(count(db, 'chameleon_reading_links'), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data WHERE id = ?').get(data2).n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('the additive upgrade links no historical row, changes none and re-applies cleanly', () => {
  const sql = fs.readFileSync(path.join(migrationsDir, migrationFile()), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE devices (deveui TEXT PRIMARY KEY);
      CREATE TABLE device_data (id INTEGER PRIMARY KEY AUTOINCREMENT, deveui TEXT NOT NULL REFERENCES devices(deveui) ON DELETE CASCADE, recorded_at TEXT NOT NULL, swt_1 REAL);
      CREATE TABLE chameleon_readings (id INTEGER PRIMARY KEY AUTOINCREMENT, deveui TEXT NOT NULL REFERENCES devices(deveui) ON DELETE CASCADE, recorded_at TEXT NOT NULL, i2c_missing INTEGER DEFAULT 0);
      INSERT INTO devices VALUES ('${EUI_A}');
      INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES ('${EUI_A}', '2026-10-01T06:00:00.000Z', 42);
      INSERT INTO chameleon_readings (deveui, recorded_at, i2c_missing) VALUES ('${EUI_A}', '2026-10-01T06:00:00.000Z', 0);`);
    const before = {
      data: db.prepare('SELECT * FROM device_data').all().map((r) => ({ ...r })),
      readings: db.prepare('SELECT * FROM chameleon_readings').all().map((r) => ({ ...r })),
    };
    db.exec(sql);
    // A unique device/timestamp pair is not proof of one uplink: no inferred link.
    assert.equal(count(db, 'chameleon_reading_links'), 0);
    assert.deepEqual(db.prepare('SELECT * FROM device_data').all().map((r) => ({ ...r })), before.data);
    assert.deepEqual(db.prepare('SELECT * FROM chameleon_readings').all().map((r) => ({ ...r })), before.readings);
    db.exec(sql);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

// A prefix corpus keeps the accepted CHECKSUMS.json entries; it never rehashes.
function corpusUpTo(dir, maxVersion) {
  const accepted = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'CHECKSUMS.json'), 'utf8'));
  const manifest = {};
  for (const [name, checksum] of Object.entries(accepted)) {
    if (Number(name.slice(0, 4)) > maxVersion) continue;
    fs.copyFileSync(path.join(migrationsDir, name), path.join(dir, name));
    manifest[name] = checksum;
  }
  fs.writeFileSync(path.join(dir, 'CHECKSUMS.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

test('the migration runner applies the link over the prior head and links no history', async () => {
  const name = migrationFile();
  const version = Number(name.slice(0, 4));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chameleon-links-'));
  try {
    const prior = path.join(dir, 'prior');
    const head = path.join(dir, 'head');
    fs.mkdirSync(prior);
    fs.mkdirSync(head);
    corpusUpTo(prior, version - 1);
    corpusUpTo(head, version);
    const runner = cliRunner(path.join(dir, 'farming.db'));
    await bootstrapFresh(runner, { migrationsDir: prior, appVersion: 'issue356-prior' });
    await runner.exec(`
      INSERT INTO devices (deveui,name,type_id,created_at,updated_at) VALUES ('${EUI_A}','Chameleon A','DRAGINO_LSN50','2026-10-01','2026-10-01');
      INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES ('${EUI_A}', '2026-10-01T06:00:00.000Z', 42);
      INSERT INTO chameleon_readings (deveui, recorded_at, i2c_missing, timeout, data_invalid) VALUES ('${EUI_A}', '2026-10-01T06:00:00.000Z', 0, 0, 0);`);
    const before = {
      data: await runner.all('SELECT * FROM device_data ORDER BY id'),
      readings: await runner.all('SELECT * FROM chameleon_readings ORDER BY id'),
    };
    const result = await applyPending(runner, { migrationsDir: head, appVersion: 'issue356-head' });
    assert.deepEqual(result.applied, [version]);
    const verified = await verifyHead(runner, { migrationsDir: head });
    assert.equal(verified.ok, true, verified.reason);
    assert.equal((await runner.all('SELECT COUNT(*) AS n FROM chameleon_reading_links'))[0].n, 0);
    assert.deepEqual(await runner.all('SELECT * FROM device_data ORDER BY id'), before.data);
    assert.deepEqual(await runner.all('SELECT * FROM chameleon_readings ORDER BY id'), before.readings);
    assert.equal((await runner.all('PRAGMA foreign_key_check')).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
