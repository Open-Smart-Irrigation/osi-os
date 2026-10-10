#!/usr/bin/env node
'use strict';

// Behavioural test for lsn50-zone-agg-fn ("Aggregate Zone Rain/Flow"), the
// LSN50 MOD9 writer of zone_daily_environment.
//
// A flow-only uplink (the rain counter has no valid delta: first sample,
// counter reset, duplicate) used to insert rainfall_mm = 0 with
// rain_source = 'local_gauge', so the zone day read as a measured dry day.
// It now writes flow only: a new row keeps rainfall_mm NULL. Since the
// zone-day projection (policy 1, docs/contracts/rainfall/zone-day-projection.md)
// the rain columns of every row it writes are the zone's projection: the
// selected gauge's received amount in rain_received_mm, rainfall_mm only for a
// certified complete day, and a non-null rain_coverage even on a flow-only
// insert. An LSN50 counts as a rain gauge when rain_gauge_enabled = 1.
//
// Run: node --test scripts/test-lsn50-flow-only-zone-row.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNode, executeFunction, seedTestDb } = require('./lib/flow-node-harness');

function msgFor(rainStatus, rain, flowStatus, flow) {
  return {
    formattedData: {
      detectedMode: 9, devEui: 'DENDRO1', timestamp: '2026-10-08T10:00:00.000Z',
      rainDeltaStatus: rainStatus, rainMmDelta: rain, flowDeltaStatus: flowStatus, flowLitersDelta: flow,
    },
  };
}
// Node-RED runs a function body that awaits as an async function; so does this.
function asyncNode(id) {
  const node = loadNode(id);
  return { ...node, func: 'return (async () => {\n' + node.func + '\n})();' };
}
const run = (db, m) => executeFunction(asyncNode('lsn50-zone-agg-fn'), { msg: m, db });
const row = (db) => {
  const r = db.prepare("SELECT rainfall_mm, rain_received_mm, rain_coverage, flow_liters, rain_source FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get();
  return r ? { ...r } : r;
};
// DENDRO1 (zone 1) as the zone's rain gauge, with the counter rows the
// "LSN50 Normalize + Write" node stores before this node runs.
function gauge(db) {
  db.exec("UPDATE devices SET rain_gauge_enabled = 1 WHERE deveui = 'DENDRO1'");
  return db;
}
function counterRow(db, recordedAt, count, status, deltaMm, seconds) {
  db.prepare('INSERT INTO device_data (deveui, recorded_at, rain_count_cumulative, rain_mm_delta, rain_delta_status, counter_interval_seconds) '
    + "VALUES ('DENDRO1', ?, ?, ?, ?, ?)").run(recordedAt, count, deltaMm, status, seconds);
}

test('flow-only insert writes no rain and labels the row (never legacy)', async () => {
  const db = seedTestDb();
  const out = await run(db, msgFor('first_sample', null, 'ok', 12));
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(row(db), { rainfall_mm: null, rain_received_mm: null, rain_coverage: 'unknown', flow_liters: 12, rain_source: 'none' });
  db.close();
});

test('rain after a flow-only insert is the gauge projection; flow keeps adding', async () => {
  const db = gauge(seedTestDb());
  counterRow(db, '2026-10-08T09:50:00.000Z', 10, 'first_sample', null, null);
  await run(db, msgFor('first_sample', null, 'ok', 12));
  counterRow(db, '2026-10-08T10:00:00.000Z', 12, 'ok', 0.4, 600);
  await run(db, msgFor('ok', 0.4, 'ok', 3));
  assert.deepEqual(row(db), { rainfall_mm: null, rain_received_mm: 0.4, rain_coverage: 'partial', flow_liters: 15, rain_source: 'local_gauge' });
  db.close();
});

test('rain on a legacy row without rain (NULL) re-projects it at policy 1', async () => {
  const db = gauge(seedTestDb());
  db.prepare("INSERT INTO zone_daily_environment(zone_id,date,rainfall_mm,flow_liters,rain_source,computed_at) VALUES(1,'2026-10-08',NULL,4,'none','2026-10-08T09:00:00.000Z')").run();
  counterRow(db, '2026-10-08T09:50:00.000Z', 10, 'first_sample', null, null);
  counterRow(db, '2026-10-08T10:00:00.000Z', 12, 'ok', 0.4, 600);
  await run(db, msgFor('ok', 0.4, 'ok', 0));
  assert.deepEqual(row(db), { rainfall_mm: null, rain_received_mm: 0.4, rain_coverage: 'partial', flow_liters: 4, rain_source: 'local_gauge' });
  db.close();
});

test('flow-only update keeps the rain projection', async () => {
  const db = gauge(seedTestDb());
  counterRow(db, '2026-10-08T09:50:00.000Z', 10, 'first_sample', null, null);
  counterRow(db, '2026-10-08T10:00:00.000Z', 13, 'ok', 0.6, 600);
  await run(db, msgFor('ok', 0.6, 'ok', 0));
  counterRow(db, '2026-10-08T10:10:00.000Z', 2, 'counter_reset', null, null);
  await run(db, msgFor('counter_reset', null, 'ok', 5));
  const r = row(db);
  assert.deepEqual({ received: r.rain_received_mm, flow: r.flow_liters, source: r.rain_source, rainfall: r.rainfall_mm },
    { received: 0.6, flow: 5, source: 'local_gauge', rainfall: null });
  assert.equal(r.rain_coverage, 'partial', 'the counter reset is a known uncovered part of the day');
  db.close();
});

test('a valid zero rain delta is a measured dry reading received', async () => {
  const db = gauge(seedTestDb());
  counterRow(db, '2026-10-08T09:50:00.000Z', 10, 'first_sample', null, null);
  counterRow(db, '2026-10-08T10:00:00.000Z', 10, 'ok', 0, 600);
  await run(db, msgFor('ok', 0, 'first_sample', null));
  assert.deepEqual(row(db), { rainfall_mm: null, rain_received_mm: 0, rain_coverage: 'partial', flow_liters: 0, rain_source: 'local_gauge' });
  db.close();
});

test('a flow-only uplink on a legacy LoRain day labels it with the zone projection', async () => {
  const db = seedTestDb();
  db.exec("INSERT INTO devices (deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES ('A840410000000001','Gauge','AQUASCOPE_LORAIN',2,1,'2026-01-01','2026-01-01')");
  db.prepare("INSERT INTO device_data (deveui, recorded_at, rain_mm_delta, rain_delta_status) VALUES ('A840410000000001', '2026-10-08T08:00:00.000Z', 2.5, 'ok')").run();
  db.prepare("INSERT INTO zone_daily_environment(zone_id,date,rainfall_mm,flow_liters,rain_source,computed_at) VALUES(1,'2026-10-08',2.5,0,'aquascope_lorain','2026-10-08T09:00:00.000Z')").run();
  await run(db, msgFor('duplicate_timestamp', null, 'ok', 7));
  assert.deepEqual(row(db), { rainfall_mm: null, rain_received_mm: 2.5, rain_coverage: 'unknown', flow_liters: 7, rain_source: 'aquascope_lorain' },
    'the received amount stays visible; it was never certified');
  db.close();
});

test('each write that changes the row bumps sync_version once', async () => {
  const db = seedTestDb();
  await run(db, msgFor('first_sample', null, 'ok', 1));
  await run(db, msgFor('first_sample', null, 'ok', 1));
  assert.equal(db.prepare("SELECT sync_version FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get().sync_version, 1);
  await run(db, msgFor('first_sample', null, 'ok', 0));
  assert.equal(db.prepare("SELECT sync_version FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get().sync_version, 1,
    'a write that changes nothing projected bumps nothing');
  db.close();
});
