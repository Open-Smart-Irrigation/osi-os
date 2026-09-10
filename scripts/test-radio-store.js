'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { createRadioStore, normalizeUplink } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper');

const uuid = '00000000-0000-4000-8000-000000000000';
function open(file) { return new Promise((resolve, reject) => { const db = new sqlite3.Database(file, error => error ? reject(error) : resolve(db)); }); }
function call(db, method, sql, params = []) { return new Promise((resolve, reject) => { const done = (error, rows) => error ? reject(error) : resolve(rows); if (method === 'exec') db[method](sql, done); else db[method](sql, params, done); }); }
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-radio-')), farmingFile = path.join(dir, 'farming.db'), radioFile = path.join(dir, 'radio.db');
  const db = await open(farmingFile);
  await call(db, 'exec', `CREATE TABLE installation_identity(singleton_id INTEGER PRIMARY KEY, installation_uuid TEXT, recovery_state TEXT);
    CREATE TABLE radio_store_identity(singleton_id INTEGER PRIMARY KEY, radio_store_uuid TEXT, installation_uuid TEXT, state TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE sync_history_dirty_keys(peer_node TEXT, table_name TEXT, row_key TEXT, change_kind TEXT, source_row_id INTEGER, changed_at TEXT, status TEXT, PRIMARY KEY(peer_node, table_name, row_key));
    CREATE TABLE radio_history_bridge(history_key TEXT PRIMARY KEY, generation INTEGER, status TEXT, transferred_at TEXT);
    INSERT INTO installation_identity VALUES(1, '${uuid}', 'ACTIVE');`);
  const farming = { get: (sql, params) => call(db, 'all', sql, params).then(rows => rows[0]), transaction: async fn => { await call(db, 'exec', 'BEGIN'); try { const tx = { get: farming.get, run: (sql, params) => call(db, 'run', sql, params) }; const result = await fn(tx); await call(db, 'exec', 'COMMIT'); return result; } catch (error) { await call(db, 'exec', 'ROLLBACK'); throw error; } } };
  return { dir, radioFile, db, farming };
}
function row(receivers, id = 'native-1') { return normalizeUplink({ deveui: 'AABBCCDDEEFF0011', recorded_at: '2026-09-10T00:00:00Z', deduplication_id: id, metadata: { receivers } }, { installationUuid: uuid, ingestedAt: '2026-09-10T00:00:00Z' }); }

test('real SQLite store replays and merges receivers with durable generation', async t => {
  const f = await fixture(); t.after(async () => f.db.close());
  const store = createRadioStore({ dbPath: f.radioFile, dbFactory: open, farmingDb: f.farming, installationUuid: uuid, gatewayEui: '0011223344556677', enabled: true });
  t.after(() => store.close());
  assert.equal(await store.capture(row([{ gateway_id: '000000000000000A' }])), 1);
  assert.equal(await store.capture(row([{ gateway_id: '000000000000000A' }])), 1);
  assert.equal(await store.capture(row([{ gateway_id: '000000000000000A' }, { gateway_id: '000000000000000B' }])), 1);
  assert.equal((await store.all('SELECT dirty_generation FROM radio_uplinks'))[0].dirty_generation, 2);
  assert.equal(await store.bridgeDirty(f.farming), 1);
  assert.equal((await f.farming.get('SELECT count(*) AS n FROM sync_history_dirty_keys')) .n, 1);
});

test('existing radio file without identity refuses before use', async t => {
  const f = await fixture(); const orphan = await open(f.radioFile); await call(orphan, 'exec', 'CREATE TABLE orphan(value TEXT)'); await new Promise(resolve => orphan.close(resolve)); t.after(async () => f.db.close());
  const store = createRadioStore({ dbPath: f.radioFile, dbFactory: open, farmingDb: f.farming, installationUuid: uuid, gatewayEui: '0011223344556677', enabled: true });
  await assert.rejects(() => store.status(), /marker missing|recovery|required|identity/i);
  await store.close();
});

test('active marker plus deleted radio file refuses recreation', async t => {
  const f = await fixture(); t.after(async () => f.db.close());
  const options = { dbPath: f.radioFile, dbFactory: open, farmingDb: f.farming, installationUuid: uuid, gatewayEui: '0011223344556677', enabled: true };
  const first = createRadioStore(options); await first.capture(row([{ gateway_id: '000000000000000A' }])); await first.close(); fs.unlinkSync(f.radioFile);
  const second = createRadioStore(options); await assert.rejects(() => second.status(), /file missing|recovery/i); assert.equal(fs.existsSync(f.radioFile), false); await second.close();
});

test('disabled capture leaves marker and filesystem untouched', async t => {
  const f = await fixture(); t.after(async () => f.db.close());
  const store = createRadioStore({ dbPath: f.radioFile, dbFactory: open, farmingDb: f.farming, installationUuid: uuid, gatewayEui: '0011223344556677', enabled: false });
  await assert.rejects(() => store.capture(row([])), error => error.code === 'RADIO_CAPTURE_DISABLED');
  assert.equal(fs.existsSync(f.radioFile), false); assert.equal((await f.farming.get('SELECT count(*) AS n FROM radio_store_identity')).n, 0); await store.close();
});

test('blocked or mismatched installation refuses before opening radio file', async t => {
  for (const state of ['BLOCKED', 'ACTIVE']) {
    const f = await fixture(); await call(f.db, 'run', 'UPDATE installation_identity SET recovery_state=?, installation_uuid=?', [state, state === 'ACTIVE' ? '11111111-1111-4111-8111-111111111111' : uuid]);
    const store = createRadioStore({ dbPath: f.radioFile, dbFactory: open, farmingDb: f.farming, installationUuid: uuid, gatewayEui: '0011223344556677', enabled: true });
    await assert.rejects(() => store.status(), /recovery|required/i); assert.equal(fs.existsSync(f.radioFile), false); await store.close(); await new Promise(resolve => f.db.close(resolve));
  }
});

test('close and reopen preserves rows; ledger tampering is refused', async t => {
  const f = await fixture(); t.after(async () => f.db.close());
  const options = { dbPath: f.radioFile, dbFactory: open, farmingDb: f.farming, installationUuid: uuid, gatewayEui: '0011223344556677', enabled: true };
  const first = createRadioStore(options); await first.capture(row([])); await first.close();
  const second = createRadioStore(options); assert.equal((await second.status()).rows, 1); await second.close();
  const tamper = await open(f.radioFile); await call(tamper, 'run', "UPDATE radio_store_schema_ledger SET checksum='tampered' WHERE version=1"); await new Promise(resolve => tamper.close(resolve));
  const third = createRadioStore(options); await assert.rejects(() => third.status(), /checksum/i); await third.close();
});

test('stat failure and WAL/free-space budget pause without inserting rows', async t => {
  const f = await fixture(); t.after(async () => f.db.close());
  const failingFs = { ...fs, statSync(file) { if (file === f.radioFile) throw new Error('stat unavailable'); return fs.statSync(file); }, statfsSync: () => ({ bavail: 100, bsize: 1 }) };
  const failed = createRadioStore({ dbPath: f.radioFile, dbFactory: open, fs: failingFs, farmingDb: f.farming, installationUuid: uuid, gatewayEui: '0011223344556677', enabled: true });
  await assert.rejects(() => failed.capture(row([])), /filesystem size inspection failed/); await failed.close();
  const b = await fixture(); const budgetFs = { ...fs, statSync(file) { if (file === b.radioFile || file === b.radioFile + '-wal') return { size: 1000 }; return fs.statSync(file); }, statfsSync: () => ({ bavail: 1, bsize: 1 }) };
  const paused = createRadioStore({ dbPath: b.radioFile, dbFactory: open, fs: budgetFs, budgetBytes: 100, freeSpaceFloorBytes: 10, farmingDb: b.farming, installationUuid: uuid, gatewayEui: '0011223344556677', enabled: true });
  await assert.rejects(() => paused.capture(row([], 'budget')), /RADIO_STORAGE_BUDGET|budget/); assert.equal((await paused.status()).rows, 0); await paused.close(); await new Promise(resolve => b.db.close(resolve));
});

test('bridge failure is retryable and a later correction remains pending until retried', async t => {
  const f = await fixture(); t.after(async () => f.db.close());
  const store = createRadioStore({ dbPath: f.radioFile, dbFactory: open, farmingDb: f.farming, installationUuid: uuid, gatewayEui: '0011223344556677', enabled: true });
  await store.capture(row([{ gateway_id: '000000000000000A' }])); const broken = { transaction: async () => { throw new Error('target unavailable'); } };
  await assert.rejects(() => store.bridgeDirty(broken), /target unavailable/);
  await store.capture(row([{ gateway_id: '000000000000000A' }, { gateway_id: '000000000000000B' }])); assert.equal((await store.all("SELECT generation,status FROM radio_history_dirty"))[0].generation, 2); assert.equal((await store.all("SELECT status FROM radio_history_dirty"))[0].status, 'pending');
  assert.equal(await store.bridgeDirty(f.farming), 1); assert.equal((await store.all("SELECT status FROM radio_history_dirty"))[0].status, 'transferred'); await store.close();
});

test('oversized and conflicting native identity inputs reject atomically', async t => {
  const f = await fixture(); t.after(async () => f.db.close());
  const store = createRadioStore({ dbPath: f.radioFile, dbFactory: open, farmingDb: f.farming, installationUuid: uuid, gatewayEui: '0011223344556677', enabled: true });
  await store.capture(row(Array.from({ length: 64 }, (_, index) => ({ gateway_id: index.toString(16).padStart(16, '0') }))));
  await assert.rejects(() => store.capture(row([{ gateway_id: 'FFFFFFFFFFFFFFFF' }])), /merged radio metadata exceeds limit/);
  const conflict = row([{ gateway_id: '000000000000000A' }]); conflict.deveui = 'FFEEDDCCBBAA0099'; await assert.rejects(() => store.capture(conflict), /device or timestamp/);
  await assert.throws(() => normalizeUplinkForTest(), /64 KiB/); assert.equal((await store.status()).rows, 1); await store.close();
});

function normalizeUplinkForTest() {
  const { normalizeUplink } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper');
  return normalizeUplink({ deveui: 'AABBCCDDEEFF0011', deduplication_id: 'huge', metadata: { receivers: [], radio: { coding_rate: 'x'.repeat(70000) } } }, { installationUuid: uuid });
}
