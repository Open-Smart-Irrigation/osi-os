'use strict';
// LoRain dry reports and the zone day window.
// Run with a pinned host timezone: TZ=UTC node --test scripts/test-lorain-dry-zone-row.js
// (the result must not depend on it; TZ=Pacific/Auckland must pass as well).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode, executeFunction, seedTestDb } = require('./lib/flow-node-harness');

const EUI = 'A840410000000001';
// Node-RED runs a function body as an AsyncFunction; the shared harness uses a plain
// Function, so a body with top-level `await` is wrapped here.
function asyncNode(id) {
  const node = loadNode(id);
  return { ...node, func: 'return (async () => {\n' + node.func + '\n})();' };
}
function seed(tz) {
  const db = seedTestDb();
  db.exec(`UPDATE irrigation_zones SET timezone='${tz}' WHERE id=1;
    INSERT INTO devices (deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at)
    VALUES ('${EUI}','Gauge','AQUASCOPE_LORAIN',2,1,'2026-01-01','2026-01-01');`);
  return db;
}
function uplink(time, tips, extra = {}) {
  return { payload: { deviceInfo: { devEui: EUI, deviceProfileName: 'Aqua-Scope LoRain' }, time,
    deduplicationId: 'dedup-' + time, fCnt: 1, object: { rain_tips_delta: tips, rain_mm_delta: tips * 0.5, ...extra } } };
}
async function ingest(db, time, tips, extra) {
  const proc = await executeFunction(asyncNode('lorain-process-fn'), { msg: uplink(time, tips, extra), db });
  const [rowMsg, aggMsg] = proc.result;
  if (rowMsg) {
    const sql = await executeFunction(loadNode('lorain-sql-fn'), { msg: rowMsg, db });
    db.exec(sql.result.topic);
  }
  if (aggMsg) {
    const agg = await executeFunction(asyncNode('lorain-rain-agg-fn'), { msg: aggMsg, db });
    assert.deepEqual(agg.errors, []);
  }
  return proc.result;
}

test('a valid zero report creates a zone row with 0 mm and the gauge source', async () => {
  const db = seed('UTC');
  await ingest(db, '2026-10-08T10:00:00.000Z', 0);
  const row = db.prepare("SELECT rainfall_mm, rain_source FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get();
  assert.deepEqual({ ...row }, { rainfall_mm: 0, rain_source: 'aquascope_lorain' });
});

test('a silent gauge has no zone row', async () => {
  const db = seed('UTC');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM zone_daily_environment').get().n, 0);
});

test('non-ok zero does not reach the zone table', async () => {
  const db = seed('UTC');
  await ingest(db, '2026-10-08T10:00:00.000Z', 1);
  // An older report than the stored one is classified duplicate_or_out_of_order by lorain-process-fn.
  const [, aggMsg] = await ingest(db, '2026-10-08T09:00:00.000Z', 0);
  assert.equal(aggMsg, null);
  const row = db.prepare("SELECT rainfall_mm FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get();
  assert.equal(row.rainfall_mm, 0.5);
});

test('seeds a new zone day from the zone-local window, not the host day', async () => {
  const db = seed('Europe/Zurich');
  // 20:00Z on 2026-10-24 is 22:00 local (CEST); 10 mm on the 24th.
  await ingest(db, '2026-10-24T20:00:00.000Z', 20);
  // 23:15Z on 2026-10-24 is 01:15 local on the 25th (the 25-hour day); host day (UTC) is still the 24th.
  await ingest(db, '2026-10-24T23:15:00.000Z', 1);
  const day25 = db.prepare("SELECT rainfall_mm FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-25'").get();
  assert.equal(day25.rainfall_mm, 0.5, 'never 10.5 mm carried over from the host day');
  const day24 = db.prepare("SELECT rainfall_mm FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-24'").get();
  assert.equal(day24.rainfall_mm, 10);
});

test('a dry report after rain keeps the day total, refreshes computed_at, and does not bump sync_version', async () => {
  const db = seed('UTC');
  await ingest(db, '2026-10-08T10:00:00.000Z', 2);
  const before = db.prepare("SELECT sync_version, computed_at FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get();
  await new Promise((r) => setTimeout(r, 5));
  await ingest(db, '2026-10-08T11:00:00.000Z', 0);
  const after = db.prepare("SELECT rainfall_mm, sync_version, computed_at FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get();
  assert.equal(after.rainfall_mm, 1);
  assert.equal(after.sync_version, before.sync_version);
  assert.ok(after.computed_at > before.computed_at, 'dry evidence refreshes computed_at');
});

// The installed gauges send nothing while dry and a heartbeat (0 tips) every 4 hours;
// each heartbeat writes its zero at its own time and implies nothing about the gap before it.
test('repeated dry heartbeats on a linked gateway emit one outbox event and one dirty key per zone day', async () => {
  const db = seed('UTC');
  db.exec("INSERT INTO sync_link_state(peer_node, linked, updated_at) VALUES ('cloud', 1, '2026-01-01T00:00:00.000Z');");
  for (const time of ['2026-10-08T00:30:00.000Z', '2026-10-08T04:30:00.000Z', '2026-10-08T08:30:00.000Z', '2026-10-08T12:30:00.000Z']) {
    await ingest(db, time, 0);
  }
  const outbox = db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='ZONE_ENVIRONMENT'").get();
  assert.equal(outbox.n, 1, 'only the insert of the zone day reaches the outbox while nothing changes');
  const dirty = db.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE table_name='zone_daily_environment'").get();
  assert.equal(dirty.n, 1, 'history dirty keys coalesce on one key per zone day');
});

// A zero heartbeat never takes over a zone day another source owns (orchestrator ruling
// on finding 2 interim): the row, its version and its freshness stay as they are.
function seedOwnedRow(db, source, mm) {
  db.exec(`INSERT INTO zone_daily_environment(zone_id,date,rainfall_mm,flow_liters,rain_source,computed_at,sync_version)
    VALUES (1,'2026-10-08',${mm},12,'${source}','2026-10-08T09:00:00.000Z',4);`);
}
function zoneDay(db) {
  return { ...db.prepare("SELECT rainfall_mm, flow_liters, rain_source, computed_at, sync_version FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get() };
}

test('a zero heartbeat leaves an S2120-owned zone day and its sync_version unchanged', async () => {
  const db = seed('UTC');
  seedOwnedRow(db, 'sensecap_s2120', 3.2);
  const before = zoneDay(db);
  await ingest(db, '2026-10-08T10:00:00.000Z', 0);
  assert.deepEqual(zoneDay(db), before);
});

test('a zero heartbeat leaves an LSN50 local_gauge zone day unchanged (no ping-pong)', async () => {
  const db = seed('UTC');
  seedOwnedRow(db, 'local_gauge', 0);
  const before = zoneDay(db);
  await ingest(db, '2026-10-08T10:00:00.000Z', 0);
  await ingest(db, '2026-10-08T14:00:00.000Z', 0);
  assert.deepEqual(zoneDay(db), before);
});

test('a zero heartbeat with no zone day inserts 0 mm owned by the gauge', async () => {
  const db = seed('UTC');
  await ingest(db, '2026-10-08T10:00:00.000Z', 0);
  const row = zoneDay(db);
  assert.equal(row.rainfall_mm, 0);
  assert.equal(row.rain_source, 'aquascope_lorain');
  assert.equal(row.sync_version, 0);
});
