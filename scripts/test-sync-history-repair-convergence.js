'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { PROFILES, createHarness } = require('./history-sync-flow-harness');
const GATEWAY = '0016C001F1000001';
const SENSOR = 'A840410000000001';
const key = id => `DEVICE_DATA|${GATEWAY}|${id}`;
const pending = db => db.prepare("SELECT COUNT(*) n FROM sync_history_dirty_keys WHERE table_name='device_data' AND status='pending'").get().n;
function fixture(t, profile, count = 300, extra = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(fs.readFileSync('database/seed-blank.sql', 'utf8'));
  db.prepare("INSERT INTO users(id,username,password_hash,user_uuid,server_url,server_sync_token,created_at) VALUES(1,'fixture','x','fixture','https://cloud.invalid','fixture-token','2026-11-01')").run();
  db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,gateway_device_eui,created_at,updated_at) VALUES(?,'fixture','DRAGINO_LSN50',1,?,'2026-11-01','2026-11-01')").run(SENSOR, GATEWAY);
  db.prepare("INSERT INTO sync_link_state(peer_node,linked,server_url,gateway_device_eui,updated_at) VALUES('cloud',1,'https://cloud.invalid',?,'2026-11-01')").run(GATEWAY);
  let radio;
  if (extra.includeRadio) {
    radio = new DatabaseSync(':memory:');
    t.after(() => radio.close());
    radio.exec('CREATE TABLE radio_uplinks(id INTEGER PRIMARY KEY,installation_uuid TEXT,deveui TEXT,recorded_at TEXT,deduplication_id TEXT,metadata_json TEXT,dirty_generation INTEGER)');
    db.prepare("INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,recovery_state,created_at,updated_at) VALUES(1,'00000000-0000-4000-8000-000000000001',?,'ACTIVE','2026-07-01','2026-07-01')").run(GATEWAY);
  }
  const h = createHarness({ db, radio, profile, env: { DEVICE_EUI: GATEWAY, AUTH_TOKEN_SECRET: 'fixture-secret', OSI_RADIO_CAPTURE_ENABLED: extra.includeRadio ? '1' : '0' }, ...extra });
  const insert = db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1) VALUES(?,?,?,20)');
  db.exec('BEGIN');
  for (let id = 1; id <= count; id++) insert.run(id, SENSOR, new Date(Date.UTC(2026, 6, 1) + (id - 1) * 300000).toISOString());
  const groups = new Map();
  for (const row of db.prepare('SELECT * FROM device_data').all()) {
    const segment = h.helper.segmentKey('device_data', row);
    if (!groups.has(segment)) groups.set(segment, []);
    groups.get(segment).push(row);
  }
  const put = db.prepare("INSERT INTO sync_history_segments(peer_node,table_name,segment_key,hash_version,canonical_row_count,syncable_row_count,syncable_payload_hash,computed_at) VALUES('cloud','device_data',?,1,?,?,?,'2026-11-01')");
  for (const [segment, values] of groups) {
    const m = h.helper.buildSegment('device_data', GATEWAY, segment, values).manifest;
    put.run(segment, m.canonicalRowCount, m.syncableRowCount, m.syncablePayloadHash);
  }
  const cursor = db.prepare("INSERT INTO sync_history_cursors(peer_node,table_name,state,shadow_completed_at,durable_enabled_at,snapshot_high_id,last_acked_id,snapshot_high_key,last_acked_key) VALUES('cloud',?,'tail','2026-11-01','2026-11-01',?,?,?,?)");
  for (const table of h.helper.tableNames({ includeRadio: extra.includeRadio })) {
    const numeric = h.helper.cursorKind(table) === 'id';
    cursor.run(table, numeric ? (table === 'device_data' ? count : 0) : null, numeric ? (table === 'device_data' ? count : 0) : null, numeric ? null : '', numeric ? null : '');
  }
  db.exec('COMMIT');
  h.memory.set('history_sync_last_table', 'tensiomark_observations');
  return { db, h, insert };
}
for (const profile of PROFILES) {
  test(`${profile}: upgrade adopts a segment checkpoint without resetting legacy done keys`, async t => {
    const { db, h } = fixture(t, profile, 3);
    db.prepare("INSERT INTO sync_history_dirty_keys(peer_node,table_name,row_key,change_kind,changed_at,status) VALUES('cloud','device_data',?,'repair','2026-07-01','done')").run(key(1));
    await h.manifest();
    assert.equal(db.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(key(1)).status, 'done');
    assert.equal(pending(db), 2, 'missing keys still queue');
  });
  test(`${profile}: unchanged manifest preserves done keys and retries across restart`, async t => {
    const { db, h } = fixture(t, profile);
    await h.manifest();
    await h.tick();
    const before = db.prepare("SELECT * FROM sync_history_dirty_keys WHERE status='done' ORDER BY row_key").all();
    assert.ok(before.length > 0);
    const waiting = db.prepare("SELECT row_key FROM sync_history_dirty_keys WHERE status='pending' LIMIT 1").get();
    db.prepare("UPDATE sync_history_dirty_keys SET attempts=2,next_attempt_at='2099-01-01',last_error='retry' WHERE row_key=?").run(waiting.row_key);
    const retry = db.prepare('SELECT * FROM sync_history_dirty_keys WHERE row_key=?').get(waiting.row_key);
    h.advance(300000);
    const restarted = createHarness({ db, profile, env: { DEVICE_EUI: GATEWAY } });
    await restarted.manifest();
    assert.deepEqual(db.prepare("SELECT * FROM sync_history_dirty_keys WHERE status='done' ORDER BY row_key").all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM sync_history_dirty_keys WHERE row_key=?').get(waiting.row_key), retry);
  });
  test(`${profile}: changed segments requeue done rows and preserve UPDATE corrections`, async t => {
    const { db, h } = fixture(t, profile);
    await h.manifest();
    await h.tick();
    assert.equal(db.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(key(1)).status, 'done');
    db.prepare('UPDATE device_data SET swt_1=37 WHERE id=1').run();
    const correction = db.prepare('SELECT * FROM sync_history_dirty_keys WHERE row_key=?').get(key(1));
    assert.equal(correction.status, 'pending');
    assert.equal(correction.change_kind, 'correction');
    h.advance(300000);
    await h.manifest();
    assert.deepEqual(db.prepare('SELECT * FROM sync_history_dirty_keys WHERE row_key=?').get(key(1)), correction);
    assert.equal(db.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(key(2)).status, 'pending');
    for (let i = 0; i < 150 && pending(db); i++) await h.tick();
    assert.equal(pending(db), 0);
    assert.equal(h.cloud.index.get('device_data\0' + key(1)), h.helper.prepareRow('device_data', GATEWAY, db.prepare('SELECT * FROM device_data WHERE id=1').get()).payloadHash);
  });
  test(`${profile}: old ACK cannot consume an intervening correction`, async t => {
    const { db, h } = fixture(t, profile, 2);
    await h.manifest();
    const built = await h.invoke('sync-history-build', {});
    const answered = await h.invoke('sync-history-http', built);
    db.prepare('UPDATE device_data SET swt_1=99 WHERE id=1').run();
    // SQLite's timestamp granularity can give two updates the same dirty time.
    // The submitted payload hash must fence the ACK even in that case.
    db.prepare('UPDATE sync_history_dirty_keys SET changed_at=? WHERE row_key=?').run(built._historyBatch.dirtyVersions[key(1)], key(1));
    await h.invoke('sync-history-mark', answered);
    assert.equal(db.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(key(1)).status, 'pending');
    assert.equal(db.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(key(2)).status, 'done');
  });
  test(`${profile}: row-loading deadline shortens a batch and leaves the rest queued`, async t => {
    const { db, h } = fixture(t, profile, 300);
    await h.manifest();
    let elapsed = 0;
    const q = async (sql, params = []) => db.prepare(sql).all(...params);
    const loaded = await h.helper.loadDirtyRows({ q, tableName: 'device_data', now: new Date(h.now()).toISOString(), skipRepair: false,
      sourceQuery: async (table, sql, params) => { elapsed += 75; return q(sql, params); },
      clock: () => elapsed, node: { warn: assert.fail }, setSyncState: assert.fail });
    assert.equal(loaded.rows.length, 3, 'stops after the first read crossing 200 ms');
    assert.equal(pending(db), 300, 'building never completes unsent keys');
  });
  test(`${profile}: repair checkpoint and dirty keys roll back together`, async t => {
    const { db, h } = fixture(t, profile, 3);
    db.exec("CREATE TEMP TRIGGER reject_test_key BEFORE INSERT ON sync_history_dirty_keys WHEN NEW.source_row_id=2 BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await h.manifest();
    assert.equal(pending(db), 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM app_settings WHERE key LIKE 'history_repair_segment:%'").get().n, 0);
    db.exec('DROP TRIGGER reject_test_key');
    await h.manifest();
    assert.equal(pending(db), 3);
  });
  test(`${profile}: clearing the dirty ledger for a relink queues missing keys despite an old checkpoint`, async t => {
    const { db, h } = fixture(t, profile, 2);
    await h.manifest();
    await h.tick();
    db.exec("DELETE FROM sync_history_dirty_keys WHERE peer_node='cloud'");
    const restarted = createHarness({ db, profile, env: { DEVICE_EUI: GATEWAY } });
    await restarted.manifest();
    assert.equal(pending(db), 2, 'new cloud lacks the rows');
  });
  test(`${profile}: authenticated sync state reports fresh pending repair counts`, async t => {
    const { db, h } = fixture(t, profile, 2, { fs: { existsSync: () => false } });
    await h.manifest();
    const payload = Buffer.from(JSON.stringify({ userId: 1, username: 'fixture' })).toString('base64url');
    const token = payload + '.' + crypto.createHmac('sha256', 'fixture-secret').update(payload).digest('base64url');
    const request = () => h.invoke('sync-state-build', { req: { headers: { authorization: 'Bearer ' + token } } });
    assert.equal((await h.invoke('sync-state-build', { req: { headers: {} } })).statusCode, 401);
    let response = await request();
    assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
    assert.equal(response.payload.historyRepairPendingByTable.device_data, 2);
    assert.equal(response.payload.historyRepairPendingByTable.radio_uplinks, 0);
    await h.tick();
    response = await request();
    assert.equal(response.payload.historyRepairPendingByTable.device_data, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_history_dirty_keys WHERE status='done'").get().n, 2);
  });
  test(`${profile}: unchanged radio segment preserves completed repairs`, async t => {
    const { db } = fixture(t, profile, 1);
    const radio = new DatabaseSync(':memory:');
    t.after(() => radio.close());
    radio.exec('CREATE TABLE radio_uplinks(id INTEGER PRIMARY KEY,installation_uuid TEXT,deveui TEXT,recorded_at TEXT,deduplication_id TEXT,metadata_json TEXT,dirty_generation INTEGER)');
    radio.prepare('INSERT INTO radio_uplinks VALUES(1,?,?,?,?,?,1)').run('00000000-0000-4000-8000-000000000001', SENSOR, '2026-07-01T00:00:00.000Z', 'fixture-dedup', '{"version":1,"receivers":[]}');
    db.prepare("INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,recovery_state,created_at,updated_at) VALUES(1,'00000000-0000-4000-8000-000000000001',?,'ACTIVE','2026-07-01','2026-07-01')").run(GATEWAY);
    db.prepare("INSERT INTO sync_history_cursors(peer_node,table_name,state,shadow_completed_at,snapshot_high_id,last_acked_id) VALUES('cloud','radio_uplinks','tail','2026-07-01',1,1)").run();
    const h = createHarness({ db, radio, profile, env: { DEVICE_EUI: GATEWAY, OSI_RADIO_CAPTURE_ENABLED: '1' }, lastTable: 'tensiomark_observations' });
    const comparison = { tableName: 'radio_uplinks', segmentKey: SENSOR + '|2026-07-01', repairRequested: true };
    const mark = () => h.invoke('sync-history-manifest-mark', { statusCode: 200, payload: { segments: [comparison] } });
    await mark();
    db.prepare("INSERT INTO radio_history_bridge(history_key,generation,status) VALUES(?,1,'transferred')").run(`RADIO_UPLINK|${GATEWAY}|1`);
    await h.tick();
    const status = () => db.prepare("SELECT status FROM sync_history_dirty_keys WHERE table_name='radio_uplinks'").get().status;
    assert.equal(status(), 'done');
    h.advance(300000);
    await mark();
    assert.equal(status(), 'done');
    radio.exec("UPDATE radio_uplinks SET metadata_json='{\"version\":1,\"receivers\":[],\"changed\":true}',dirty_generation=2");
    await mark();
    assert.equal(status(), 'pending', 'a different radio payload is repaired');
    assert.deepEqual(h.warnings, []);
  });
  test(`${profile}: 10,000 repairs converge in 800 ticks with refreshes and continuous tail`, async t => {
    const { db, h, insert } = fixture(t, profile, 10000, { manifestEvery: 10, includeRadio: true });
    const tables = h.helper.tableNames({ includeRadio: true });
    assert.equal(tables.length, 10);
    let visits = 0;
    let liveId = 10000;
    for (let tick = 0; tick < 800; tick++) {
      if (h.helper.nextTable(h.memory.get('history_sync_last_table'), tables) === 'device_data') {
        visits++;
        insert.run(++liveId, SENSOR, new Date(Date.UTC(2026, 10, 1) + visits * 300000).toISOString());
      }
      await h.tick();
      const batches = h.cloud.batches.filter(b => b.tableName === 'device_data');
      if (batches.length >= 2) assert.ok(!batches.slice(-2).every(b => b.phase === 'repair'), 'waiting tail is served between repairs');
      const done = db.prepare("SELECT COUNT(*) n FROM sync_history_dirty_keys WHERE table_name='device_data' AND status='done'").get().n;
      if (done >= 10000 && pending(db) === 0) break;
    }
    assert.equal(pending(db), 0);
    for (let id = 1; id <= 10000; id++) assert.ok(h.cloud.index.has('device_data\0' + key(id)), `missing ${id}`);
    assert.ok(visits <= 80, `at most 80 table visits, got ${visits}`);
    const repaired = h.cloud.batches.filter(b => b.tableName === 'device_data' && b.phase === 'repair');
    assert.equal(repaired.length, 40);
    assert.equal(repaired.flatMap(b => b.keys).length, 10000, 'no repeated repair delivery');
    assert.deepEqual(h.cloud.batches.filter(b => b.rejected), []);
    assert.deepEqual(h.warnings, []);
  });
}
