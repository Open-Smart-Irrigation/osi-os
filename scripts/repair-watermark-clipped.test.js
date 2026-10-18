'use strict';

const { afterEach, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const repair = require('./repair-watermark-clipped');
const REPO = path.resolve(__dirname, '..');
const SEED = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db');
const EUI = 'A840410000000001';
const OTHER = 'A840410000000002';
const GATEWAY = '0016C001F1000001';
let dir; let dbPath;
const open = () => new DatabaseSync(dbPath);

function setup({ linked = true } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-clipped-'));
  dbPath = path.join(dir, 'farming.db'); fs.copyFileSync(SEED, dbPath);
  const db = open(); const now = '2026-10-17T00:00:00.000Z';
  db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES(1,'owner','x',?)").run(now);
  for (const eui of [EUI, OTHER]) db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,gateway_device_eui) VALUES(?,?,'DRAGINO_LSN50',1,?,?,?)").run(eui, eui, now, now, GATEWAY);
  if (linked) db.prepare("INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) VALUES('cloud',1,?,?)").run(GATEWAY, now);
  db.close();
}
function row({ eui = EUI, at, n = 1, bound = 11.2, flags = 0x20, source = 2, status = 2, temp = 18, ddEui = eui, ddAt = at, swt = null, linked = true }) {
  const db = open();
  const dd = Number(db.prepare('INSERT INTO device_data(deveui,recorded_at,swt_1,swt_2) VALUES(?,?,?,?)').run(ddEui, ddAt, n === 1 ? swt : null, n === 2 ? swt : null).lastInsertRowid);
  const values = n === 1 ? [flags, bound, 'wet_offset_clipped', null, 0x20, null, 'ok', 20] : [0x20, null, 'ok', 20, flags, bound, 'wet_offset_clipped', null];
  const wr = Number(db.prepare('INSERT INTO watermark_readings(deveui,recorded_at,device_data_id,payload_hex,frame_status,soil_temp_c,soil_temp_source,status_byte,ch1_flags,ch1_kpa_upper_bound,ch1_status,ch1_kpa,ch2_flags,ch2_kpa_upper_bound,ch2_status,ch2_kpa,conversion_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(eui, at, linked ? dd : null, 'x', 'accepted', temp, source, status, ...values, 'wm-lsn50-p3-v2').lastInsertRowid);
  db.prepare("UPDATE sync_outbox SET delivered_at=occurred_at WHERE aggregate_type='DEVICE_DATA' AND aggregate_key=? AND delivered_at IS NULL").run(eui + '|' + at);
  db.close(); return { dd, wr };
}
function snapshot() { const db = open(); const out = { dd: db.prepare('SELECT id,deveui,recorded_at,swt_1,swt_2 FROM device_data ORDER BY id').all(), wr: db.prepare('SELECT id,ch1_kpa,ch2_kpa,ch1_kpa_upper_bound,ch2_kpa_upper_bound,conversion_version FROM watermark_readings ORDER BY id').all(), dirty: db.prepare("SELECT source_row_id FROM sync_history_dirty_keys WHERE table_name='device_data' ORDER BY source_row_id").all(), outbox: db.prepare('SELECT count(*) n FROM sync_outbox').get().n }; db.close(); return JSON.parse(JSON.stringify(out)); }
function pending(eui, at) { const db = open(); const id = 'pending-' + at + '-' + db.prepare('SELECT count(*) n FROM sync_outbox').get().n; db.prepare("INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,occurred_at) VALUES(?,'DEVICE_DATA',?,'DEVICE_DATA_APPENDED','{}',?)").run(id, eui + '|' + at, at); db.close(); }

describe('repair-watermark-clipped', () => {
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => setup());

  it('dry run preserves data and reports only finite matching clipped candidates', async () => {
    const one = row({ at: '2026-10-01T00:00:00.000Z', bound: 0 });
    const two = row({ at: '2026-10-01T00:01:00.000Z', n: 2, bound: 93.2 });
    row({ at: '2026-10-01T00:02:00.000Z', bound: 201 });
    row({ at: '2026-10-01T00:03:00.000Z', bound: 'not-a-number' });
    row({ at: '2026-10-01T00:03:30.000Z', bound: -0.1 });
    row({ at: '2026-10-01T00:04:00.000Z', bound: 11.2, flags: 0x21 });
    row({ at: '2026-10-01T00:05:00.000Z', bound: 11.2, source: 1 });
    row({ at: '2026-10-01T00:05:30.000Z', bound: 11.2, temp: null });
    row({ at: '2026-10-01T00:05:45.000Z', bound: 11.2, temp: 51 });
    row({ at: '2026-10-01T00:06:00.000Z', bound: 11.2, status: 6 });
    row({ at: '2026-10-01T00:07:00.000Z', bound: 11.2, ddEui: OTHER });
    row({ at: '2026-10-01T00:08:00.000Z', bound: 11.2, ddAt: '2026-10-01T01:08:00.000Z' });
    row({ at: '2026-10-01T00:09:00.000Z', bound: 11.2, swt: 4 });
    const raw = row({ at: '2026-10-01T00:09:30.000Z', bound: 11.2 }); const rawDb = open(); rawDb.prepare('UPDATE watermark_readings SET ch1_kpa=8 WHERE id=?').run(raw.wr); rawDb.close();
    row({ at: '2026-10-01T00:10:00.000Z', bound: 11.2, linked: false });
    const before = snapshot(); const result = await repair.run(dbPath, { log: () => {} });
    assert.deepEqual(snapshot(), before);
    assert.equal(result.planned, 2); assert.deepEqual(result.ids, [one.wr, two.wr]);
  });

  it('applies both values atomically, preserves raw evidence, and relies on dirty sync', async () => {
    const one = row({ at: '2026-10-01T00:00:00.000Z', bound: 11.2 });
    const two = row({ at: '2026-10-01T00:01:00.000Z', n: 2, bound: 0 });
    const before = snapshot(); const result = await repair.run(dbPath, { apply: true, log: () => {} }); const after = snapshot();
    assert.equal(result.filled, 2); assert.equal(after.dd.find(x => x.id === one.dd).swt_1, 11.2); assert.equal(after.dd.find(x => x.id === two.dd).swt_2, 0);
    assert.equal(after.wr.find(x => x.id === one.wr).ch1_kpa, 11.2); assert.equal(after.wr.find(x => x.id === two.wr).ch2_kpa, 0);
    assert.equal(after.wr.find(x => x.id === one.wr).ch1_kpa_upper_bound, before.wr.find(x => x.id === one.wr).ch1_kpa_upper_bound);
    assert.deepEqual(after.dirty.map(x => x.source_row_id), [one.dd, two.dd].sort((a,b) => a-b)); assert.equal(after.outbox, before.outbox);
    assert.equal((await repair.run(dbPath, { apply: true, log: () => {} })).filled, 0);
  });

  it('returns rejected history corrections to pending through the existing dirty-key trigger', async () => {
    const one = row({ at: '2026-10-01T00:00:00.000Z' }); const db = open();
    db.prepare("INSERT INTO sync_history_dirty_keys(peer_node,table_name,row_key,change_kind,source_row_id,changed_at,status,attempts,last_error) VALUES('cloud','device_data',?,'correction',?,'2000-01-01','rejected',4,'old')").run('DEVICE_DATA|' + GATEWAY + '|' + one.dd, one.dd); db.close();
    await repair.run(dbPath, { apply: true, log: () => {} }); const dirty = open().prepare("SELECT status,attempts,last_error FROM sync_history_dirty_keys WHERE source_row_id=?").get(one.dd);
    assert.deepEqual({ ...dirty }, { status: 'pending', attempts: 0, last_error: null });
  });

  it('requires a verified backup, a linked gateway, and no pending append event', async () => {
    const candidate = row({ at: '2026-10-01T00:00:00.000Z' }); pending(EUI, '2026-10-01T00:00:00.000Z'); const before = snapshot();
    await assert.rejects(repair.run(dbPath, { apply: true, log: () => {} }), /unsent DEVICE_DATA_APPENDED/); assert.deepEqual(snapshot(), before);
    const db = open(); db.prepare("UPDATE sync_outbox SET delivered_at=occurred_at").run(); db.prepare("UPDATE sync_link_state SET linked=0 WHERE peer_node='cloud'").run(); db.close();
    await assert.rejects(repair.run(dbPath, { apply: true, log: () => {} }), /linked gateway/);
    const b = fs.readdirSync(dir).filter(x => x.includes('.bak-')); assert.ok(b.length >= 1);
    const backup = new DatabaseSync(path.join(dir, b[0])); assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); backup.close();
    assert.equal(snapshot().dd.find(x => x.id === candidate.dd).swt_1, null);
  });

  it('rolls both tables back if device_data update fails', async () => {
    const a = row({ at: '2026-10-01T00:00:00.000Z' }); const b = row({ at: '2026-10-01T00:01:00.000Z' });
    const db = open(); db.exec("CREATE TRIGGER fail_repair BEFORE UPDATE OF swt_1 ON device_data WHEN NEW.id = " + b.dd + " BEGIN SELECT RAISE(ABORT,'boom'); END"); db.close(); const before = snapshot();
    await assert.rejects(repair.run(dbPath, { apply: true, log: () => {} }), /boom/); assert.deepEqual(snapshot(), before); assert.ok(a);
  });

  it('uses the locked candidates rather than a stale dry-run plan', async () => {
    const first = row({ at: '2026-10-01T00:00:00.000Z', bound: 11.2 });
    let added;
    const result = await repair.run(dbPath, { apply: true, log: () => {}, beforeTransaction: () => { added = row({ at: '2026-10-01T00:01:00.000Z', bound: 12.3 }); } });
    assert.deepEqual(result.ids, [first.wr, added.wr]); assert.equal(result.filled, 2);
  });

  it('does not report a preflight candidate removed before the write lock', async () => {
    const candidate = row({ at: '2026-10-01T00:00:00.000Z' });
    const result = await repair.run(dbPath, { apply: true, log: () => {}, beforeTransaction: () => { const db = open(); db.prepare('UPDATE watermark_readings SET ch1_kpa=7 WHERE id=?').run(candidate.wr); db.close(); } });
    assert.equal(result.planned, 1); assert.equal(result.filled, 0); assert.deepEqual(result.ids, []);
  });

  it('refuses ambiguous duplicate raw rows for one canonical channel without writes', async () => {
    const first = row({ at: '2026-10-01T00:00:00.000Z' });
    const db = open();
    const second = Number(db.prepare("INSERT INTO watermark_readings(deveui,recorded_at,device_data_id,payload_hex,frame_status,soil_temp_c,soil_temp_source,status_byte,ch1_flags,ch1_kpa_upper_bound,ch1_status,ch1_kpa,ch2_flags,ch2_status,ch2_kpa,conversion_version) SELECT deveui,recorded_at,device_data_id,'dup','accepted',soil_temp_c,soil_temp_source,status_byte,ch1_flags,19.9,'wet_offset_clipped',NULL,ch2_flags,ch2_status,ch2_kpa,'wm-lsn50-p3-v1' FROM watermark_readings WHERE id=?").run(first.wr).lastInsertRowid); db.close();
    const before = snapshot(); await assert.rejects(repair.run(dbPath, { apply: true, log: () => {} }), /ambiguous/); assert.deepEqual(snapshot(), before); assert.ok(second);
  });

  it('uses the exact stored device_data event key and rechecks link and pending state under lock', async () => {
    const mixed = row({ at: '2026-10-01T00:00:00.000Z' }); const caseDb = open(); caseDb.prepare('UPDATE watermark_readings SET deveui=lower(deveui) WHERE id=?').run(mixed.wr); caseDb.close();
    pending(EUI, '2026-10-01T00:00:00.000Z'); const before = snapshot();
    await assert.rejects(repair.run(dbPath, { apply: true, log: () => {} }), /unsent DEVICE_DATA_APPENDED/); assert.deepEqual(snapshot(), before);
    const db = open(); db.prepare("UPDATE sync_outbox SET delivered_at=occurred_at").run(); db.close();
    await assert.rejects(repair.run(dbPath, { apply: true, log: () => {}, beforeTransaction: () => { const d = open(); d.prepare("UPDATE sync_link_state SET linked=0 WHERE peer_node='cloud'").run(); d.close(); } }), /state changed/);
    const db2 = open(); db2.prepare("UPDATE sync_link_state SET linked=1 WHERE peer_node='cloud'").run(); db2.close();
    await assert.rejects(repair.run(dbPath, { apply: true, log: () => {}, beforeTransaction: () => pending(EUI, '2026-10-01T00:00:00.000Z') }), /state changed/);
    assert.equal(snapshot().dd.find(x => x.id === mixed.dd).swt_1, null);
  });

  it('refuses when the history dirty trigger is absent', async () => {
    row({ at: '2026-10-01T00:00:00.000Z' }); const db = open(); db.exec('DROP TRIGGER trg_sync_device_data_dirty_au'); db.close(); const before = snapshot();
    await assert.rejects(repair.run(dbPath, { apply: true, log: () => {} }), /dirty-key trigger/); assert.deepEqual(snapshot(), before);
  });
});
