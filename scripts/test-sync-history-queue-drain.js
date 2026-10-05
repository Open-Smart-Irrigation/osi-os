'use strict';
// History correction queue (sync_history_dirty_keys) drains in order against a
// cloud that rejects a batch whose rows are not in ascending history-key order.
// Runs the shipped Build History Batch / POST History Batch / Mark History Batch
// ACK bodies of both profiles on real SQLite (node:sqlite).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { PROFILES, createHarness, loadProfile } = require('./history-sync-flow-harness');

const root = path.resolve(__dirname, '..');
const GATEWAY = '0016C001F1000001';
const OLD_GATEWAY = '0016C001F1000002';
const SENSOR = 'A840410000000001';
const SOIL = 'A840410000000002';
const DENDROS = ['A840410000000013', 'A840410000000011', 'A840410000000012'];
const T_DEAD = '2026-08-14T23:40:11.459Z';

function seed(db) {
  db.exec(fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8'));
  db.prepare("INSERT INTO users(id,username,password_hash,user_uuid,server_url,server_sync_token,created_at) VALUES(1,'fixture','x','fixture-user','https://cloud.invalid','fixture-token','2026-08-01T00:00:00.000Z')").run();
  const device = db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,gateway_device_eui) VALUES(?,?,?,1,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z',?)");
  device.run(SENSOR, 'Sensor', 'DRAGINO_LSN50', GATEWAY);
  device.run(SOIL, 'Soil', 'DRAGINO_LSN50', GATEWAY);
  for (const eui of DENDROS) device.run(eui, 'Dendro ' + eui.slice(-2), 'DRAGINO_LSN50', GATEWAY);
  const cursor = db.prepare("INSERT INTO sync_history_cursors(peer_node,table_name,state,shadow_completed_at,durable_enabled_at,backfill_completed_at,snapshot_high_id,snapshot_high_key,last_acked_id,last_acked_key) VALUES('cloud',?,'tail','2026-08-05T00:00:00.000Z','2026-08-05T00:00:00.000Z','2026-08-05T00:00:00.000Z',?,?,?,?)");
  return cursor;
}

function link(db) {
  db.prepare("INSERT INTO sync_link_state(peer_node,linked,server_url,gateway_device_eui,updated_at) VALUES('cloud',1,'https://cloud.invalid',?,'2026-08-01T00:00:00.000Z') ON CONFLICT(peer_node) DO UPDATE SET linked=1,server_url=excluded.server_url,gateway_device_eui=excluded.gateway_device_eui").run(GATEWAY);
}

function dirty(db, table, rowKey, kind, changedAt, attempts = 0) {
  db.prepare("INSERT INTO sync_history_dirty_keys(peer_node,table_name,row_key,change_kind,changed_at,status,attempts) VALUES('cloud',?,?,?,?,'pending',?)").run(table, rowKey, kind, changedAt, attempts);
}

function key(id) { return `DEVICE_DATA|${GATEWAY}|${id}`; }

// A queue shaped like the field case: dead keys in front (rows deleted with
// their device, one changed_at, some already retried), old never-sent repair
// keys behind them whose ids mix three and four digits, new corrections last.
function gatewayShapedFixture(db) {
  const cursor = seed(db);
  const insert = db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1,swt_2,dendro_valid) VALUES(?,?,?,?,?,1)');
  const at = (id) => new Date(Date.UTC(2026, 7, 12) + id * 300000).toISOString();
  for (let id = 500; id <= 1500; id += 1) insert.run(id, SENSOR, at(id), 20 + (id % 7), null);
  for (let id = 5600; id <= 7300; id += 1) insert.run(id, SOIL, at(id), id % 3 === 0 ? null : 25.5, null);
  const deadIds = [];
  for (let id = 541; id <= 1480; id += 8) for (let k = 0; k < 4 && id + k <= 1480; k += 1) deadIds.push(id + k);
  db.prepare(`DELETE FROM device_data WHERE id IN (${deadIds.join(',')})`).run();
  const oldIds = [];
  for (let id = 537; id <= 1476; id += 8) oldIds.push(id);
  oldIds.push(6096, 6101, 6129, 1002, 1003);
  const corrections = [];
  for (let id = 5640; id <= 7294; id += 33) corrections.push(id);
  const daily = db.prepare('INSERT INTO dendrometer_daily(deveui,date,mds_um,twd_um,stress_level,computed_at) VALUES(?,?,?,?,?,?)');
  const days = [];
  for (let d = 13; d <= 31; d += 1) days.push(`2026-07-${String(d).padStart(2, '0')}`);
  for (const day of days) for (const eui of DENDROS) daily.run(eui, day, 30.5, 12.25, 'low', `${day}T23:00:00.000Z`);
  cursor.run('device_data', '7300', null, '7300', null);
  cursor.run('dendrometer_daily', null, `${DENDROS[0]}|2026-07-31`, null, `${DENDROS[0]}|2026-07-31`);
  for (const table of ['chameleon_readings', 'dendrometer_readings', 'irrigation_events']) cursor.run(table, '0', null, '0', null);
  for (const table of ['zone_daily_environment', 'zone_daily_recommendations', 'valve_actuation_expectations']) cursor.run(table, null, '', null, '');
  link(db);
  deadIds.forEach((id, i) => dirty(db, 'device_data', key(id), 'repair', T_DEAD, i < deadIds.length / 2 ? 9000 + i : 0));
  oldIds.forEach((id, i) => dirty(db, 'device_data', key(id), 'repair', new Date(Date.UTC(2026, 7, 14, 23, 50) + i).toISOString()));
  corrections.forEach((id, i) => dirty(db, 'device_data', key(id), 'correction', new Date(Date.UTC(2026, 9, 5, 9, 2) + i).toISOString()));
  // dendrometer_daily keys in day-major order (all devices of a day, then the next day).
  let n = 0;
  for (const day of days) for (const eui of DENDROS) dirty(db, 'dendrometer_daily', `DENDRO_DAILY|${eui}|${day}`, 'upsert', new Date(Date.UTC(2026, 7, 12, 14, 53) + n++).toISOString());
  return { deadIds, oldIds, corrections, dailyCount: days.length * DENDROS.length };
}

function statusCounts(db, table) {
  const out = {};
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM sync_history_dirty_keys WHERE table_name=? GROUP BY status').all(table)) out[row.status] = Number(row.n);
  return out;
}

async function drain(h, maxTicks) {
  let ticks = 0;
  for (; ticks < maxTicks; ticks += 1) {
    const pending = h.db.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE status='pending'").get().n;
    if (!pending) break;
    await h.tick();
  }
  return ticks;
}

test('compareHistoryKeys orders id keys numerically and other keys by code unit', () => {
  for (const profile of PROFILES) {
    const { helper } = loadProfile(profile);
    assert.equal(typeof helper.compareHistoryKeys, 'function', profile);
    assert.equal(helper.compareHistoryKeys('device_data', key(6129), key(1001)), 1);
    assert.equal(helper.compareHistoryKeys('device_data', key(999), key(1000)), -1);
    assert.equal(helper.compareHistoryKeys('device_data', key(7), key(7)), 0);
    assert.equal(helper.compareHistoryKeys('dendrometer_daily', 'A0000000-0000-4000-8000-000000000001|2026-09-10', 'A0000000-0000-4000-8000-000000000001|2026-09-11'), -1);
    assert.equal(helper.compareHistoryKeys('dendrometer_daily', 'A0000000-0000-4000-8000-000000000001|2026-09-11', 'a0000000-0000-4000-8000-000000000001|2026-09-10'), -1);
  }
});

// The cloud compares two keys numerically when both tails parse as a Java
// Long, otherwise by code unit (EdgeHistoryIngestService.firstOutOfOrderNumericRow),
// for every table. A valve expectation id is the cloud command id when there is one.
test('compareHistoryKeys follows the cloud rule for every table, including numeric valve ids', () => {
  const valve = (id) => `VALVE_ACTUATION|${GATEWAY}|${id}`;
  for (const profile of PROFILES) {
    const { helper } = loadProfile(profile);
    assert.equal(helper.compareHistoryKeys('valve_actuation_expectations', valve(999), valve(1000)), -1, profile);
    assert.equal(helper.compareHistoryKeys('valve_actuation_expectations', valve(1000), valve(999)), 1, profile);
    assert.equal(helper.compareHistoryKeys('valve_actuation_expectations', valve(-2), valve(-10)), 1, profile);
    // Only one tail parses: both sides compare the whole key by code unit.
    assert.equal(helper.compareHistoryKeys('valve_actuation_expectations', valve(1000), valve('0b7c5a52-0000-4000-8000-000000000001')), 1, profile);
    // Past the Long range the cloud no longer parses the tail either.
    assert.equal(helper.compareHistoryKeys('valve_actuation_expectations', valve('9223372036854775808'), valve('10')), 1, profile);
    assert.equal(helper.compareHistoryKeys('valve_actuation_expectations', valve('9223372036854775807'), valve('10')), 1, profile);
    assert.equal(helper.compareHistoryKeys('valve_actuation_expectations', valve('9223372036854775807'), valve('9223372036854775807')), 0, profile);
  }
});

test('a valve correction batch with command ids of different lengths is accepted in one pass', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const cursor = seed(db);
  const insert = db.prepare("INSERT INTO valve_actuation_expectations(expectation_id,device_eui,commanded_at,commanded_duration_seconds,expected_close_at,volume_source,created_at) VALUES(?,?,?,600,?,'none',?)");
  for (const id of ['1000', '999']) insert.run(id, SOIL, '2026-10-05T08:00:00.000Z', '2026-10-05T08:10:00.000Z', '2026-10-05T08:00:00.000Z');
  for (const table of ['device_data', 'chameleon_readings', 'dendrometer_readings', 'irrigation_events']) cursor.run(table, '0', null, '0', null);
  for (const table of ['dendrometer_daily', 'zone_daily_environment', 'zone_daily_recommendations', 'valve_actuation_expectations']) cursor.run(table, null, '', null, '');
  link(db);
  const valve = (id) => `VALVE_ACTUATION|${GATEWAY}|${id}`;
  dirty(db, 'valve_actuation_expectations', valve(1000), 'upsert', '2026-10-05T09:00:00.000Z');
  dirty(db, 'valve_actuation_expectations', valve(999), 'upsert', '2026-10-05T09:00:01.000Z');
  const h = createHarness({ db, lastTable: 'irrigation_events', env: { DEVICE_EUI: GATEWAY } });
  await h.tick();
  const batches = h.cloud.batches.filter((b) => b.tableName === 'valve_actuation_expectations');
  assert.deepEqual(batches.map((b) => [b.keys, b.rejected]), [[[valve(999), valve(1000)], null]]);
  assert.deepEqual(statusCounts(db, 'valve_actuation_expectations'), { done: 2 });
});

test('a correction batch is sent in ascending row id order whatever the queue order', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const cursor = seed(db);
  const insert = db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1) VALUES(?,?,?,?)');
  for (const id of [999, 1000, 1001, 6129]) insert.run(id, SENSOR, `2026-08-13T00:${String(id % 60).padStart(2, '0')}:00.000Z`, 21);
  cursor.run('device_data', '6129', null, '6129', null);
  link(db);
  [[6129, 1], [1001, 2], [999, 3], [1000, 4]].forEach(([id, s]) => dirty(db, 'device_data', key(id), 'repair', `2026-08-14T23:50:0${s}.000Z`));
  const h = createHarness({ db, lastTable: 'valve_actuation_expectations', env: { DEVICE_EUI: GATEWAY } });
  const built = await h.invoke('sync-history-build', {});
  assert.ok(built, 'a batch is built');
  assert.deepEqual(Array.from(built.payload.rows, (row) => Number(row.payload.id)), [999, 1000, 1001, 6129]);
});

test('a queued key whose row no longer exists is dropped with a counted, logged reason', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const cursor = seed(db);
  db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1) VALUES(10,?,?,21)').run(SENSOR, '2026-08-13T00:00:00.000Z');
  cursor.run('device_data', '10', null, '10', null);
  link(db);
  dirty(db, 'device_data', key(3), 'repair', T_DEAD, 4000);
  dirty(db, 'device_data', key(4), 'repair', T_DEAD);
  dirty(db, 'device_data', key(10), 'repair', '2026-08-15T00:00:00.000Z');
  const h = createHarness({ db, lastTable: 'valve_actuation_expectations', env: { DEVICE_EUI: GATEWAY } });
  const built = await h.invoke('sync-history-build', {});
  assert.deepEqual(Array.from(built.payload.rows, (row) => Number(row.payload.id)), [10]);
  const dead = db.prepare("SELECT row_key, status, last_error, next_attempt_at FROM sync_history_dirty_keys WHERE row_key IN (?,?) ORDER BY row_key").all(key(3), key(4));
  assert.deepEqual(dead.map((r) => [r.status, r.last_error, r.next_attempt_at]), [['dropped', 'source row missing', null], ['dropped', 'source row missing', null]]);
  assert.ok(h.warnings.some((w) => /dropped 2 queued device_data key\(s\): source row missing/.test(w)), h.warnings.join('\n'));
});

for (const profile of PROFILES) {
  test(`${profile}: a gateway-shaped queue drains completely and in order`, async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const shape = gatewayShapedFixture(db);
    const h = createHarness({ db, profile, env: { DEVICE_EUI: GATEWAY } });
    const ticks = await drain(h, 8 * 60);
    assert.deepEqual(statusCounts(db, 'device_data'), { done: shape.oldIds.length + shape.corrections.length, dropped: shape.deadIds.length });
    assert.deepEqual(statusCounts(db, 'dendrometer_daily'), { done: shape.dailyCount });
    const rejected = h.cloud.batches.filter((b) => b.rejected);
    assert.deepEqual(rejected, [], 'the cloud rejected no batch');
    for (const batch of h.cloud.batches) {
      const sorted = batch.keys.slice().sort((a, b) => h.helper.compareHistoryKeys(batch.tableName, a, b));
      assert.deepEqual(batch.keys, sorted, `${batch.tableName} batch ascending`);
    }
    const sent = h.cloud.batches.filter((b) => b.tableName === 'device_data').flatMap((b) => b.keys);
    const position = (id) => sent.indexOf(key(id));
    for (const id of shape.oldIds) assert.ok(position(id) >= 0, `old key ${id} sent`);
    for (const id of shape.corrections) assert.ok(position(id) >= 0, `correction ${id} sent`);
    assert.ok(Math.max(...shape.oldIds.map(position)) < Math.min(...shape.corrections.map(position)), 'old items before new corrections');
    for (const id of shape.deadIds) assert.equal(position(id), -1, `dead key ${id} not sent`);
    const droppedLogged = h.warnings.map((w) => /dropped (\d+) queued device_data key/.exec(w)).filter(Boolean).reduce((s, m) => s + Number(m[1]), 0);
    assert.equal(droppedLogged, shape.deadIds.length, 'every dropped key is counted in the log');
    const cursors = db.prepare("SELECT table_name, retry_count, next_attempt_at FROM sync_history_cursors WHERE table_name IN ('device_data','dendrometer_daily')").all();
    for (const c of cursors) {
      assert.equal(c.retry_count, 0, c.table_name);
      assert.ok(!c.next_attempt_at || Date.parse(c.next_attempt_at) <= h.now(), c.table_name + ' not backed off');
    }
    assert.ok(ticks < 8 * 60, `drained in ${ticks} ticks`);
  });
}

test('a key re-queued between the row lookup and the drop is not dropped', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const cursor = seed(db);
  cursor.run('device_data', '40', null, '40', null);
  link(db);
  dirty(db, 'device_data', key(41), 'repair', T_DEAD);
  dirty(db, 'device_data', key(42), 'repair', T_DEAD);
  const h = createHarness({
    db,
    lastTable: 'valve_actuation_expectations',
    env: { DEVICE_EUI: GATEWAY },
    afterAll: (sql, params, rows, raw) => {
      // Row 41 is written again right after its lookup came back empty; its
      // trigger re-queues the key with a new changed_at.
      if (/FROM device_data WHERE id = \?/.test(sql) && String(params[0]) === '41' && !rows.length) {
        raw.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1) VALUES(41,?,?,21)').run(SENSOR, '2026-08-13T00:00:00.000Z');
        raw.prepare("UPDATE sync_history_dirty_keys SET changed_at='2026-10-06T08:00:00.000Z', status='pending' WHERE row_key=?").run(key(41));
      }
    }
  });
  await h.invoke('sync-history-build', {});
  const row = (id) => db.prepare('SELECT status, changed_at FROM sync_history_dirty_keys WHERE row_key=?').get(key(id));
  assert.deepEqual([row(41).status, row(41).changed_at], ['pending', '2026-10-06T08:00:00.000Z']);
  assert.equal(row(42).status, 'dropped');
  assert.ok(h.warnings.some((w) => /dropped 1 queued device_data key\(s\)/.test(w)), h.warnings.join('\n'));
});

test('a row-level permanent rejection sets that key aside and does not block the table', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const cursor = seed(db);
  const insert = db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1) VALUES(?,?,?,21)');
  for (const id of [11, 12, 13]) insert.run(id, SENSOR, `2026-08-13T00:${id}:00.000Z`);
  cursor.run('device_data', '13', null, '13', null);
  link(db);
  for (const id of [11, 12, 13]) dirty(db, 'device_data', key(id), 'correction', '2026-10-05T09:00:00.000Z');
  const h = createHarness({ db, lastTable: 'valve_actuation_expectations', env: { DEVICE_EUI: GATEWAY }, cloud: { hashMismatch: new Set([key(12)]) } });
  await h.tick();
  assert.deepEqual(statusCounts(db, 'device_data'), { done: 1, pending: 2 });
  const aside = db.prepare('SELECT status, attempts, last_error, next_attempt_at FROM sync_history_dirty_keys WHERE row_key=?').get(key(12));
  assert.equal(aside.last_error, 'permanent: hash_mismatch');
  assert.equal(aside.attempts, 1);
  assert.ok(Date.parse(aside.next_attempt_at) > h.now(), 'the rejected key waits');
  const cur = db.prepare("SELECT next_attempt_at, retry_count FROM sync_history_cursors WHERE table_name='device_data'").get();
  assert.ok(cur.next_attempt_at === null || cur.next_attempt_at < '9999', 'the table is not parked: ' + cur.next_attempt_at);
  assert.equal(cur.retry_count, 0);
  // Next visit sends the key behind it.
  h.memory.set('history_sync_last_table', 'valve_actuation_expectations');
  const next = await h.invoke('sync-history-build', {});
  assert.deepEqual(Array.from(next.payload.rows, (row) => Number(row.payload.id)), [13]);
  // After three permanent rejections the key is terminal and counted.
  h.memory.set('history_sync_last_table', 'irrigation_events');
  for (let i = 0; i < 80 && db.prepare("SELECT status FROM sync_history_dirty_keys WHERE row_key=?").get(key(12)).status === 'pending'; i += 1) await h.tick();
  const final = db.prepare('SELECT status, attempts, last_error FROM sync_history_dirty_keys WHERE row_key=?').get(key(12));
  assert.deepEqual([final.status, final.attempts, final.last_error], ['rejected', 3, 'permanent: hash_mismatch']);
  assert.deepEqual(statusCounts(db, 'device_data'), { done: 2, rejected: 1 });
  assert.ok(h.warnings.some((w) => /device_data key .*12 rejected permanently \(hash_mismatch\)/.test(w)), h.warnings.join('\n'));
});

test('a systemic rejection keeps the table backed off and sets no key aside', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const cursor = seed(db);
  db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1) VALUES(21,?,?,21)').run(SENSOR, '2026-08-13T00:00:00.000Z');
  cursor.run('device_data', '21', null, '21', null);
  link(db);
  dirty(db, 'device_data', key(21), 'correction', '2026-10-05T09:00:00.000Z');
  const h = createHarness({ db, lastTable: 'valve_actuation_expectations', env: { DEVICE_EUI: GATEWAY }, cloud: { systemicReason: 'unsupported_protocol_version' } });
  const sentAt = h.now();
  await h.tick();
  const row = db.prepare('SELECT status, attempts, last_error FROM sync_history_dirty_keys WHERE row_key=?').get(key(21));
  assert.deepEqual([row.status, row.attempts, row.last_error], ['pending', 0, null]);
  const cur = db.prepare("SELECT next_attempt_at, retry_count, last_error FROM sync_history_cursors WHERE table_name='device_data'").get();
  assert.equal(cur.retry_count, 1);
  assert.ok(Date.parse(cur.next_attempt_at) > sentAt, 'the table is backed off');
  assert.equal(cur.last_error, 'permanent: unsupported_protocol_version');
});

// Field shape of the manifest loop: four segments of one day, 118 rows each,
// interleaved ids 537..1476, all queued as repair keys; the cloud's row index
// lacks the rows with ids 827..996, which sort last in string order. Before the
// manifest kept pending keys in place, every cycle re-dated all 472 keys and the
// same first 100 were re-sent for ever.
const SEGMENT_NODES = ['A840410000000021', 'A840410000000022', 'A840410000000023', 'A840410000000024'];

function manifestFixture(db, h) {
  const cursor = seed(db);
  const device = db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,gateway_device_eui) VALUES(?,?,'DRAGINO_LSN50',1,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z',?)");
  SEGMENT_NODES.forEach((eui, i) => device.run(eui, 'Node ' + i, GATEWAY));
  const insert = db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1,dendro_valid) VALUES(?,?,?,?,1)');
  const ids = [];
  for (let j = 0; j < 118; j += 1) {
    for (let k = 0; k < 4; k += 1) {
      const id = 537 + k + 8 * j;
      insert.run(id, SEGMENT_NODES[3 - k], new Date(Date.UTC(2026, 7, 13, 0, 0) + j * 600000 + k * 1000).toISOString(), 20 + (j % 9));
      ids.push(id);
    }
  }
  // dead keys of a deleted device in front, as on the gateway
  const deadIds = [];
  for (let j = 0; j < 30; j += 1) deadIds.push(541 + 8 * j);
  cursor.run('device_data', '1476', null, '1476', null);
  for (const table of ['chameleon_readings', 'dendrometer_readings', 'irrigation_events']) cursor.run(table, '0', null, '0', null);
  for (const table of ['dendrometer_daily', 'zone_daily_environment', 'zone_daily_recommendations', 'valve_actuation_expectations']) cursor.run(table, null, '', null, '');
  link(db);
  const helper = h.helper;
  const segmentRows = new Map();
  for (const row of db.prepare('SELECT * FROM device_data ORDER BY id').all()) {
    const segmentKey = helper.segmentKey('device_data', row);
    if (!segmentRows.has(segmentKey)) segmentRows.set(segmentKey, []);
    segmentRows.get(segmentKey).push(row);
    const prepared = helper.prepareRow('device_data', GATEWAY, row);
    if (row.id < 827 || row.id > 996) h.cloud.seed('device_data', prepared.historyKey, segmentKey, prepared.payloadHash);
  }
  const segmentInsert = db.prepare("INSERT INTO sync_history_segments(peer_node,table_name,segment_key,hash_version,canonical_row_count,syncable_row_count,syncable_payload_hash,quarantined_count,tombstone_count,covered_max_id,computed_at) VALUES('cloud','device_data',?,1,?,?,?,0,0,1476,'2026-08-14T00:00:00.000Z')");
  for (const [segmentKey, rows] of segmentRows) {
    const manifest = helper.buildSegment('device_data', GATEWAY, segmentKey, rows).manifest;
    segmentInsert.run(segmentKey, manifest.canonicalRowCount, manifest.syncableRowCount, manifest.syncablePayloadHash);
  }
  deadIds.forEach((id) => dirty(db, 'device_data', key(id + 100000), 'repair', T_DEAD, 9000));
  ids.forEach((id) => dirty(db, 'device_data', key(id), 'repair', '2026-08-14T23:45:00.000Z'));
  return { ids, deadIds, missing: ids.filter((id) => id >= 827 && id <= 996) };
}

for (const profile of PROFILES) {
  test(`${profile}: with the 5-minute manifest, a segment the cloud lacks rows of converges and the tail runs again`, async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const h = createHarness({ db, profile, env: { DEVICE_EUI: GATEWAY }, manifestEvery: 10, start: '2026-10-06T08:00:00.000Z' });
    const shape = manifestFixture(db, h);
    assert.equal(shape.missing.length, 86);
    let drainedAtTick = null;
    for (let i = 0; i < 6 * 120; i += 1) {
      await h.tick();
      const pending = db.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE table_name='device_data' AND status='pending'").get().n;
      if (pending === 0 && drainedAtTick === null) drainedAtTick = i;
    }
    assert.notEqual(drainedAtTick, null, 'device_data queue drained; still pending: ' + db.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE table_name='device_data' AND status='pending'").get().n);
    assert.deepEqual(statusCounts(db, 'device_data'), { done: shape.ids.length, dropped: shape.deadIds.length });
    for (const id of shape.missing) assert.ok(h.cloud.index.has('device_data\u0000' + key(id)), `row ${id} reached the cloud`);
    assert.deepEqual(h.cloud.manifests.at(-1).filter((s) => s.startsWith('device_data|')), [], 'the last manifest requests no device_data repair');
    // The tail runs again: a new row reaches the cloud through the tail.
    db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1,dendro_valid) VALUES(2001,?,?,22,1)').run(SEGMENT_NODES[0], '2026-10-06T12:00:00.000Z');
    const before = h.cloud.batches.length;
    for (let i = 0; i < 16; i += 1) await h.tick();
    const tail = h.cloud.batches.slice(before).filter((b) => b.tableName === 'device_data' && b.phase === 'tail');
    assert.ok(tail.some((b) => b.keys.includes(key(2001))), 'the new row went out in a tail batch');
    assert.deepEqual(h.cloud.batches.filter((b) => b.rejected), []);
  });
}

test('the manifest keeps a pending key in place, with its last error, and does not revive a rejected key', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const h = createHarness({ db, env: { DEVICE_EUI: GATEWAY }, start: '2026-10-06T08:00:00.000Z' });
  const shape = manifestFixture(db, h);
  const [first, second] = shape.ids;
  db.prepare("UPDATE sync_history_dirty_keys SET attempts=2, next_attempt_at='2026-10-06T08:04:00.000Z', last_error='permanent: hash_mismatch' WHERE row_key=?").run(key(first));
  db.prepare("UPDATE sync_history_dirty_keys SET status='rejected', attempts=3, last_error='permanent: hash_mismatch' WHERE row_key=?").run(key(second));
  const third = shape.ids[2];
  db.prepare("UPDATE sync_history_dirty_keys SET status='done' WHERE row_key=?").run(key(third));
  const fourth = shape.ids[3];
  db.prepare("UPDATE sync_history_dirty_keys SET status='dropped', last_error='source row missing' WHERE row_key=?").run(key(fourth));
  assert.ok(await h.manifest());
  const row = (id) => db.prepare('SELECT status, changed_at, attempts, next_attempt_at, last_error FROM sync_history_dirty_keys WHERE row_key=?').get(key(id));
  assert.deepEqual({ ...row(first) }, { status: 'pending', changed_at: '2026-08-14T23:45:00.000Z', attempts: 2, next_attempt_at: '2026-10-06T08:04:00.000Z', last_error: 'permanent: hash_mismatch' }, 'a key set aside keeps its reason until it completes or turns rejected');
  assert.equal(row(second).status, 'rejected');
  assert.equal(row(second).attempts, 3);
  assert.deepEqual([row(third).status, row(third).changed_at], ['pending', '2026-10-06T08:00:00.000Z'], 'a done key in a mismatching segment is queued again, dated now');
  assert.deepEqual([row(fourth).status, row(fourth).last_error], ['pending', null], 'a revived dropped key starts without the old reason');
});

// A dirty key is stored in the form the trigger or the manifest wrote it: under
// the gateway EUI of that moment, or with the device EUI as stored. The batch
// submits the key computed from the current row, so the ACK must complete the
// stored key through the submitted one, and two stored keys of one row must put
// the row in the batch once.
test('a key stored under an old gateway EUI completes, and a row queued under both EUIs goes out once', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const cursor = seed(db);
  const insert = db.prepare('INSERT INTO device_data(id,deveui,recorded_at,swt_1) VALUES(?,?,?,21)');
  for (const id of [51, 52, 53]) insert.run(id, SENSOR, `2026-08-13T00:${id}:00.000Z`);
  cursor.run('device_data', '53', null, '53', null);
  link(db);
  dirty(db, 'device_data', `DEVICE_DATA|${OLD_GATEWAY}|51`, 'correction', '2026-10-05T09:00:00.000Z');
  dirty(db, 'device_data', key(52), 'correction', '2026-10-05T09:00:01.000Z');
  dirty(db, 'device_data', `DEVICE_DATA|${OLD_GATEWAY}|52`, 'correction', '2026-10-05T09:00:02.000Z');
  dirty(db, 'device_data', key(53), 'correction', '2026-10-05T09:00:03.000Z');
  const h = createHarness({ db, lastTable: 'valve_actuation_expectations', env: { DEVICE_EUI: GATEWAY } });
  await h.tick();
  assert.deepEqual(h.cloud.batches.map((b) => [b.keys, b.rejected]), [[[key(51), key(52), key(53)], null]]);
  assert.deepEqual(statusCounts(db, 'device_data'), { done: 4 });
});

test('a daily key stored with a lower-case device EUI completes and the batch stays in submitted-key order', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const cursor = seed(db);
  const daily = db.prepare('INSERT INTO dendrometer_daily(deveui,date,mds_um,twd_um,stress_level,computed_at) VALUES(?,?,30.5,12.25,?,?)');
  daily.run(DENDROS[1], '2026-07-14', 'low', '2026-07-14T23:00:00.000Z');
  daily.run(DENDROS[2], '2026-07-13', 'low', '2026-07-13T23:00:00.000Z');
  cursor.run('dendrometer_daily', null, `${DENDROS[2]}|2026-07-14`, null, `${DENDROS[2]}|2026-07-14`);
  link(db);
  // Upper-case keys sort before lower-case ones, so the stored order differs
  // from the order of the keys the batch submits.
  dirty(db, 'dendrometer_daily', `DENDRO_DAILY|${DENDROS[1].toLowerCase()}|2026-07-14`, 'upsert', '2026-10-05T09:00:00.000Z');
  dirty(db, 'dendrometer_daily', `DENDRO_DAILY|${DENDROS[2]}|2026-07-13`, 'upsert', '2026-10-05T09:00:01.000Z');
  const h = createHarness({ db, lastTable: 'dendrometer_readings', env: { DEVICE_EUI: GATEWAY } });
  await h.tick();
  assert.deepEqual(h.cloud.batches.map((b) => [b.tableName, b.keys, b.rejected]), [
    ['dendrometer_daily', [`DENDRO_DAILY|${DENDROS[1]}|2026-07-14`, `DENDRO_DAILY|${DENDROS[2]}|2026-07-13`], null]
  ]);
  assert.deepEqual(statusCounts(db, 'dendrometer_daily'), { done: 2 });
});

// Radio history reads its rows from the radio store, not farming.db, and a
// radio key completes only while the bridge generation matches the row's.
test('radio_uplinks: dead keys are dropped, a rejected key is set aside, an old-EUI key completes', async (t) => {
  const db = new DatabaseSync(':memory:');
  const radio = new DatabaseSync(':memory:');
  t.after(() => { db.close(); radio.close(); });
  seed(db);
  const installation = '00000000-0000-4000-8000-000000000001';
  db.prepare("INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,recovery_state,created_at,updated_at) VALUES(1,?,?,'ACTIVE','2026-09-10','2026-09-10')").run(installation, GATEWAY);
  db.prepare("INSERT INTO sync_history_cursors(peer_node,table_name,state,shadow_completed_at,durable_enabled_at,backfill_completed_at,snapshot_high_id,last_acked_id) VALUES('cloud','radio_uplinks','tail','2026-09-10','2026-09-10','2026-09-10','10','10')").run();
  link(db);
  radio.exec('CREATE TABLE radio_uplinks(id INTEGER PRIMARY KEY,installation_uuid TEXT,deveui TEXT,recorded_at TEXT,deduplication_id TEXT,metadata_json TEXT,dirty_generation INTEGER)');
  const uplink = radio.prepare('INSERT INTO radio_uplinks VALUES(?,?,?,?,?,?,1)');
  for (const id of [1, 2, 3, 4, 10]) uplink.run(id, installation, SENSOR, `2026-09-10T10:${String(id).padStart(2, '0')}:00.000Z`, `native-${id}`, JSON.stringify({ version: 1, receivers: [] }));
  const radioKey = (id, gateway = GATEWAY) => `RADIO_UPLINK|${gateway}|${id}`;
  const queued = [[radioKey(5), '2026-09-10T11:00:00.000Z'], [radioKey(6), '2026-09-10T11:00:00.000Z'],
    [radioKey(1), '2026-09-10T11:01:00.000Z'], [radioKey(2), '2026-09-10T11:01:01.000Z'], [radioKey(3), '2026-09-10T11:01:02.000Z'],
    [radioKey(4, OLD_GATEWAY), '2026-09-10T11:01:03.000Z'], [radioKey(10), '2026-09-10T11:01:04.000Z']];
  for (const [rowKey, changedAt] of queued) {
    dirty(db, 'radio_uplinks', rowKey, 'correction', changedAt);
    db.prepare("INSERT INTO radio_history_bridge(history_key,generation,status) VALUES(?,1,'transferred')").run(rowKey);
  }
  const h = createHarness({ db, radio, env: { DEVICE_EUI: GATEWAY, OSI_RADIO_CAPTURE_ENABLED: '1' }, cloud: { hashMismatch: new Set([radioKey(3)]) } });
  for (let i = 0; i < 12 && db.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE table_name='radio_uplinks' AND status='pending'").get().n; i += 1) {
    h.memory.set('history_sync_last_table', 'valve_actuation_expectations');
    await h.tick();
    h.advance(300000);
  }
  const status = (rowKey) => db.prepare('SELECT status FROM sync_history_dirty_keys WHERE row_key=?').get(rowKey).status;
  assert.deepEqual(queued.map(([rowKey]) => status(rowKey)), ['dropped', 'dropped', 'done', 'done', 'rejected', 'done', 'done']);
  for (const batch of h.cloud.batches) {
    assert.equal(batch.tableName, 'radio_uplinks');
    assert.deepEqual(batch.keys, batch.keys.slice().sort((a, b) => h.helper.compareHistoryKeys('radio_uplinks', a, b)));
    assert.ok(!batch.rejected || batch.rejected === 'hash_mismatch', 'only the set-aside row is rejected: ' + batch.rejected);
  }
  const cur = db.prepare("SELECT next_attempt_at, retry_count FROM sync_history_cursors WHERE table_name='radio_uplinks'").get();
  assert.ok(!cur.next_attempt_at || cur.next_attempt_at < '9999', 'radio history is not parked');
  assert.ok(h.warnings.some((w) => /dropped 2 queued radio_uplinks key\(s\): source row missing/.test(w)), h.warnings.join('\n'));
});

// The rehearsal CLI replaces its working copy on every run, so --work must be a
// scratch directory: empty, or created by an earlier run (it holds the marker).
const REHEARSAL = path.join(root, 'scripts/rehearse-history-queue-drain.js');

function rehearse(args) {
  return spawnSync(process.execPath, [REHEARSAL, ...args, '--hours', '0.01'], { encoding: 'utf8', timeout: 60000 });
}

function scratchDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-rehearsal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seededFile(file) {
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8'));
  db.close();
}

test('the rehearsal CLI refuses a --work that is a file, foreign or under the live database directory', (t) => {
  const dir = scratchDir(t);
  const pulled = path.join(dir, 'pulled.db');
  const scratch = path.join(dir, 'scratch.db');
  seededFile(pulled);
  fs.writeFileSync(scratch, 'not a database');
  const pulledBytes = fs.readFileSync(pulled);
  // Swapped arguments: the pulled copy given as --work.
  const swapped = rehearse(['--db', scratch, '--work', pulled]);
  assert.notEqual(swapped.status, 0, 'a file as --work is refused');
  assert.match(swapped.stderr, /--work must be a scratch directory/);
  assert.deepEqual(fs.readFileSync(pulled), pulledBytes, 'the pulled copy is untouched');
  // A directory with someone else's files.
  const foreign = path.join(dir, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'keep.txt'), 'keep');
  const foreignRun = rehearse(['--db', pulled, '--work', foreign]);
  assert.notEqual(foreignRun.status, 0);
  assert.match(foreignRun.stderr, /not empty and was not created by this script/);
  assert.deepEqual(fs.readdirSync(foreign), ['keep.txt']);
  // The live database directory, directly and through a symbolic link.
  const live = rehearse(['--db', pulled, '--work', '/data/db/rehearsal']);
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /refusing a path under \/data\/db/);
  fs.symlinkSync('/data/db', path.join(dir, 'live-link'));
  const linked = rehearse(['--db', path.join(dir, 'live-link', 'farming.db'), '--work', path.join(dir, 'work')]);
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /refusing a path under \/data\/db/);
  // A --work that holds the source.
  const holder = rehearse(['--db', pulled, '--work', dir]);
  assert.notEqual(holder.status, 0);
  assert.match(holder.stderr, /--work must not contain --db/);
  assert.deepEqual(fs.readFileSync(pulled), pulledBytes, 'the pulled copy is untouched');
});

test('the rehearsal CLI works in a new or empty scratch directory and reuses its own', (t) => {
  const dir = scratchDir(t);
  const pulled = path.join(dir, 'pulled.db');
  seededFile(pulled);
  const fresh = path.join(dir, 'work');
  const first = rehearse(['--db', pulled, '--work', fresh]);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(fs.existsSync(path.join(fresh, 'farming.db')), 'the working copy lives inside --work');
  const again = rehearse(['--db', pulled, '--work', fresh]);
  assert.equal(again.status, 0, again.stderr);
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  const emptyRun = rehearse(['--db', pulled, '--work', empty]);
  assert.equal(emptyRun.status, 0, emptyRun.stderr);
  assert.ok(fs.existsSync(path.join(empty, 'farming.db')));
});
