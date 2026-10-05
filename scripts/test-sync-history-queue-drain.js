'use strict';
// History correction queue (sync_history_dirty_keys) drains in order against a
// cloud that rejects a batch whose rows are not in ascending history-key order.
// Runs the shipped Build History Batch / POST History Batch / Mark History Batch
// ACK bodies of both profiles on real SQLite (node:sqlite).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
