#!/usr/bin/env node
'use strict';

// Behavioural test for lsn50-zone-agg-fn ("Aggregate Zone Rain/Flow"), the
// LSN50 MOD9 writer of zone_daily_environment.
//
// A flow-only uplink (the rain counter has no valid delta: first sample,
// counter reset, duplicate) used to insert rainfall_mm = 0 with
// rain_source = 'local_gauge', so the zone day read as a measured dry day.
// It now writes flow only: a new row keeps rainfall_mm NULL and the column
// default rain_source 'none'; an existing row keeps its rain and source.
// Rain added to a row without rain starts from zero (NULL + x used to stay
// NULL).
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
  const r = db.prepare("SELECT rainfall_mm, flow_liters, rain_source FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get();
  return r ? { ...r } : r;
};

test('flow-only insert writes no rain', async () => {
  const db = seedTestDb();
  const out = await run(db, msgFor('first_sample', null, 'ok', 12));
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(row(db), { rainfall_mm: null, flow_liters: 12, rain_source: 'none' });
  db.close();
});

test('rain after a flow-only insert adds to zero, not to NULL', async () => {
  const db = seedTestDb();
  await run(db, msgFor('first_sample', null, 'ok', 12));
  await run(db, msgFor('ok', 0.4, 'ok', 3));
  assert.deepEqual(row(db), { rainfall_mm: 0.4, flow_liters: 15, rain_source: 'local_gauge' });
  db.close();
});

test('rain on a row without rain (NULL) is counted', async () => {
  const db = seedTestDb();
  db.prepare("INSERT INTO zone_daily_environment(zone_id,date,rainfall_mm,flow_liters,rain_source,computed_at) VALUES(1,'2026-10-08',NULL,4,'none','2026-10-08T09:00:00.000Z')").run();
  await run(db, msgFor('ok', 0.4, 'ok', 0));
  assert.deepEqual(row(db), { rainfall_mm: 0.4, flow_liters: 4, rain_source: 'local_gauge' });
  db.close();
});

test('flow-only update keeps existing rain and source', async () => {
  const db = seedTestDb();
  await run(db, msgFor('ok', 0.6, 'ok', 0));
  await run(db, msgFor('counter_reset', null, 'ok', 5));
  assert.deepEqual(row(db), { rainfall_mm: 0.6, flow_liters: 5, rain_source: 'local_gauge' });
  db.close();
});

test('a valid zero rain delta is a measured dry reading', async () => {
  const db = seedTestDb();
  await run(db, msgFor('ok', 0, 'first_sample', null));
  assert.deepEqual(row(db), { rainfall_mm: 0, flow_liters: 0, rain_source: 'local_gauge' });
  db.close();
});

test('a flow-only uplink does not relabel another gauge\'s row', async () => {
  const db = seedTestDb();
  db.prepare("INSERT INTO zone_daily_environment(zone_id,date,rainfall_mm,flow_liters,rain_source,computed_at) VALUES(1,'2026-10-08',2.5,0,'aquascope_lorain','2026-10-08T09:00:00.000Z')").run();
  await run(db, msgFor('duplicate_timestamp', null, 'ok', 7));
  assert.deepEqual(row(db), { rainfall_mm: 2.5, flow_liters: 7, rain_source: 'aquascope_lorain' });
  db.close();
});

test('each write bumps sync_version', async () => {
  const db = seedTestDb();
  await run(db, msgFor('first_sample', null, 'ok', 1));
  await run(db, msgFor('first_sample', null, 'ok', 1));
  assert.equal(db.prepare("SELECT sync_version FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get().sync_version, 1);
  db.close();
});
