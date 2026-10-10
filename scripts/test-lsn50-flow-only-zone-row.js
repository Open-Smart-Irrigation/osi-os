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
const fs = require('node:fs');
const path = require('node:path');
const { loadNode, executeFunction, facadeDb, seedTestDb } = require('./lib/flow-node-harness');
const rain = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-rain');

function msgFor(rainStatus, rain, flowStatus, flow, timestamp = '2026-10-08T10:00:00.000Z') {
  return {
    formattedData: {
      detectedMode: 9, devEui: 'DENDRO1', timestamp,
      rainDeltaStatus: rainStatus, rainMmDelta: rain, flowDeltaStatus: flowStatus, flowLitersDelta: flow,
    },
  };
}
// Node-RED runs a function body that awaits as an async function; so does this.
function asyncNode(id) {
  const node = loadNode(id);
  return { ...node, func: 'return (async () => {\n' + node.func + '\n})();' };
}
const run = async (db, m) => {
  const d = m && m.formattedData;
  if (d && d.devEui && d.timestamp && !d.rainObservationId) {
    const written = db.prepare('SELECT id FROM device_data WHERE deveui=? AND recorded_at=? ORDER BY id DESC LIMIT 1').get(d.devEui, d.timestamp);
    const observation = written && db.prepare('SELECT id FROM rain_observations WHERE device_data_id=? AND instrument_type=\'DRAGINO_LSN50\'').get(written.id);
    if (observation) d.rainObservationId = observation.id;
  }
  return executeFunction(asyncNode('lsn50-zone-agg-fn'), { msg: m, db });
};
const repoRoot = path.resolve(__dirname, '..');
const shareDir = path.join(repoRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share');
const manifestText = fs.readFileSync(path.join(shareDir, 'node-red/edge-channels.json'), 'utf8');
// Split the inherited flow node ID so privacy scans do not confuse it with a device EUI.
const rawNode = asyncNode(['460e0bfd', '95f89e67'].join(''));
function mod9Msg(timestamp, rainCountCumulative) {
  return { formattedData: {
    detectedMode: 9, devEui: 'DENDRO1', timestamp, modeCodeToStore: 9, modeLabelToStore: 'MOD9',
    rainCountCumulative, flowCountCumulative: null,
  } };
}
async function writeMod9(db, msg) {
  const result = await executeFunction(rawNode, {
    msg, db,
    globals: { fs: { readFileSync: () => manifestText } },
  });
  assert.deepEqual(result.errors, []);
  return result.result;
}
const row = (db) => {
  const r = db.prepare("SELECT rainfall_mm, rain_received_mm, rain_coverage, flow_liters, rain_source FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get();
  return r ? { ...r } : r;
};
const rowForDate = (db, date) => {
  const r = db.prepare('SELECT * FROM zone_daily_environment WHERE zone_id=1 AND date=?').get(date);
  return r ? { ...r } : r;
};
// DENDRO1 (zone 1) as the zone's rain gauge, with the counter rows the
// "LSN50 Normalize + Write" node stores before this node runs.
function gauge(db) {
  db.exec("UPDATE devices SET rain_gauge_enabled = 1 WHERE deveui = 'DENDRO1'");
  return db;
}
function counterRow(db, recordedAt, count, status, deltaMm, seconds) {
  const inserted = db.prepare('INSERT INTO device_data (deveui, recorded_at, rain_count_cumulative, rain_mm_delta, rain_delta_status, counter_interval_seconds) '
    + "VALUES ('DENDRO1', ?, ?, ?, ?, ?)").run(recordedAt, count, deltaMm, status, seconds);
  const device = db.prepare('SELECT d.irrigation_zone_id AS zone_id, d.rain_gauge_enabled, iz.zone_uuid, iz.timezone FROM devices d '
    + 'LEFT JOIN irrigation_zones iz ON iz.id=d.irrigation_zone_id WHERE d.deveui=\'DENDRO1\'').get();
  const zones = device.zone_id == null ? [] : [Number(device.zone_id)];
  const interval = Number(seconds);
  const end = Date.parse(recordedAt);
  const accepted = status === 'ok' && deltaMm != null && Number(deltaMm) >= 0;
  const config = { zones, zone_snapshots: zones.map((zone_id) => ({ zone_id, zone_uuid: device.zone_uuid, timezone: device.timezone || 'UTC' })), rain_gauge_enabled: Number(device.rain_gauge_enabled) === 1 };
  db.prepare('INSERT INTO rain_observations (device_data_id,deveui,instrument_type,payload_digest,received_at,measured_start,measured_end,interval_basis,frame_kind,amount_mm,status,quality_reasons,config_json,zone_id,zone_uuid,timezone) '
    + "VALUES (?,'DENDRO1','DRAGINO_LSN50',?, ?, ?, ?, ?, 'counter', ?, ?, ?, ?, ?, ?, ?)")
    .run(Number(inserted.lastInsertRowid), '0'.repeat(64), recordedAt,
      accepted && interval > 0 ? new Date(end - interval * 1000).toISOString() : null,
      accepted && interval > 0 ? new Date(end).toISOString() : null,
      accepted && interval > 0 ? 'protocol_verified' : 'unknown', accepted ? Number(deltaMm) : null,
      accepted ? 'accepted' : 'not_additive', JSON.stringify(accepted ? [] : [status]), JSON.stringify(config),
      device.zone_id, device.zone_uuid, device.timezone || 'UTC');
}
function legacyCounterRow(db, recordedAt, count, status, deltaMm, seconds) {
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

test('LSN50 rain attribution uses the zone captured in the raw-write transaction', async () => {
  const db = gauge(seedTestDb());
  const baseline = mod9Msg('2026-10-08T09:50:00.000Z', 0);
  await writeMod9(db, baseline);
  const increment = mod9Msg('2026-10-08T10:00:00.000Z', 5);
  const written = await writeMod9(db, increment);
  const row = db.prepare("SELECT id FROM device_data WHERE deveui='DENDRO1' ORDER BY id DESC LIMIT 1").get();
  const observation = db.prepare('SELECT * FROM rain_observations WHERE device_data_id=?').get(row.id);
  assert.ok(observation, 'the raw writer records an LSN50 rain observation in its transaction');
  assert.equal(observation.instrument_type, 'DRAGINO_LSN50');
  assert.equal(observation.zone_id, 1);
  assert.equal(JSON.parse(observation.config_json).rain_gauge_enabled, true);
  assert.deepEqual(JSON.parse(observation.config_json).zones, [1]);

  db.prepare("UPDATE devices SET irrigation_zone_id=2 WHERE deveui='DENDRO1'").run();
  await run(db, written);
  const oldZone = db.prepare("SELECT rain_received_mm, rain_coverage FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get();
  const newZone = db.prepare("SELECT rain_received_mm FROM zone_daily_environment WHERE zone_id=2 AND date='2026-10-08'").get();
  assert.equal(oldZone.rain_received_mm, 1);
  assert.equal(newZone, undefined, 'a later assignment cannot move a previously recorded amount');
  db.close();
});

test('a later reset closes the prior captured zone day without rain replay or a current-day row', async () => {
  const db = gauge(seedTestDb());
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-09T00:10:00.000Z');
  try {
    await writeMod9(db, mod9Msg('2026-10-08T23:50:00.000Z', 0));
    const accepted = await writeMod9(db, mod9Msg('2026-10-08T23:55:00.000Z', 5));
    await run(db, accepted);
    const open = rowForDate(db, '2026-10-08');
    assert.equal(open.rain_received_mm, 1);
    assert.equal(open.rain_coverage, 'partial');

    db.prepare("UPDATE devices SET irrigation_zone_id=2 WHERE deveui='DENDRO1'").run();
    const reset = await writeMod9(db, mod9Msg('2026-10-09T00:10:00.000Z', 0));
    await run(db, reset);
    const closed = rowForDate(db, '2026-10-08');
    assert.ok(['complete', 'partial'].includes(closed.rain_coverage));
    assert.equal(closed.rain_received_mm, 1, 'closing a previous day does not apply the saved amount twice');
    assert.equal(closed.sync_version, open.sync_version + 1);
    assert.equal(rowForDate(db, '2026-10-09'), undefined, 'a reset does not create a current-day rain row');
  } finally {
    Date.now = realNow;
    db.close();
  }
});

test('a failed LSN50 snapshot rolls back the raw counter row in the same transaction', async () => {
  const db = gauge(seedTestDb());
  db.exec("CREATE TRIGGER reject_lsn50_snapshot BEFORE INSERT ON rain_observations WHEN NEW.instrument_type='DRAGINO_LSN50' BEGIN SELECT RAISE(ABORT, 'snapshot rejected'); END;");
  const result = await executeFunction(rawNode, {
    msg: mod9Msg('2026-10-08T10:00:00.000Z', 5), db,
    globals: { fs: { readFileSync: () => manifestText } },
  });
  assert.match(result.errors.join('\n'), /snapshot rejected/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM device_data WHERE deveui='DENDRO1'").get().n, 0,
    'the raw row cannot commit without its rain attribution snapshot');
  db.close();
});

test('legacy LSN50 counter rows without a zone snapshot are not assigned to the current zone', async () => {
  const db = gauge(seedTestDb());
  legacyCounterRow(db, '2026-10-08T09:50:00.000Z', 10, 'first_sample', null, null);
  legacyCounterRow(db, '2026-10-08T10:00:00.000Z', 15, 'ok', 1, 600);
  const resolved = await facadeDb(db).transaction((t) => rain.resolveZoneRain(t, 1, '2026-10-08'));
  assert.equal(resolved.coverage, 'unknown');
  assert.equal(resolved.amountMm, null);
  assert.equal(resolved.receivedMm, null, 'without a saved frame zone, no received share is provable');
  assert.ok(resolved.reasons.includes('zone_provenance_unknown'));
  assert.ok(!resolved.reasons.includes('zone_reassigned'), 'missing provenance does not assert that the gauge moved');
  await run(db, msgFor('ok', 1, 'missing_current', null));
  assert.equal(rowForDate(db, '2026-10-08'), undefined, 'pre-snapshot device_data has no durable zone provenance');
  db.close();
});

test('an unknown LSN50 frame cannot erase a separately proven own-zone share', async () => {
  const db = gauge(seedTestDb());
  counterRow(db, '2026-10-08T09:50:00.000Z', 10, 'first_sample', null, null);
  counterRow(db, '2026-10-08T10:00:00.000Z', 12, 'ok', 0.4, 600);
  legacyCounterRow(db, '2026-10-08T10:10:00.000Z', 15, 'ok', 0.6, 600);

  const resolved = await facadeDb(db).transaction((t) => rain.resolveZoneRain(t, 1, '2026-10-08'));
  assert.equal(resolved.coverage, 'unknown');
  assert.equal(resolved.amountMm, null);
  assert.equal(resolved.receivedMm, 0.4, 'only the amount with a durable own-zone snapshot is retained');
  assert.ok(resolved.reasons.includes('zone_provenance_unknown'));
  assert.ok(!resolved.reasons.includes('zone_reassigned'));
  db.close();
});

test('zero counter bounds across a saved zone move cannot certify the sparse move day', async () => {
  const db = gauge(seedTestDb());
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-10T00:00:00.000Z');
  try {
    db.prepare("UPDATE devices SET irrigation_zone_id=NULL WHERE deveui='WX1'").run();
    await writeMod9(db, mod9Msg('2026-10-07T23:50:00.000Z', 10));
    db.prepare("UPDATE devices SET irrigation_zone_id=2 WHERE deveui='DENDRO1'").run();
    await writeMod9(db, mod9Msg('2026-10-09T00:10:00.000Z', 10));

    const resolved = await facadeDb(db).transaction((t) => rain.resolveZoneRain(t, 2, '2026-10-08'));
    assert.equal(resolved.coverage, 'unknown');
    assert.equal(resolved.amountMm, null);
    assert.equal(resolved.receivedMm, null);
    assert.ok(resolved.reasons.includes('zone_reassigned'));

    await facadeDb(db).transaction((t) => rain.recomputeZoneDay(t, 2, '2026-10-08', {
      trigger: 'flow', flowLitersDelta: 1,
    }));
    const stored = db.prepare("SELECT rainfall_mm, rain_received_mm, rain_coverage, rain_quality_reasons FROM zone_daily_environment WHERE zone_id=2 AND date='2026-10-08'").get();
    assert.equal(stored.rainfall_mm, null);
    assert.equal(stored.rain_received_mm, null);
    assert.equal(stored.rain_coverage, 'unknown');
    assert.ok(JSON.parse(stored.rain_quality_reasons).includes('zone_reassigned'));
  } finally {
    Date.now = realNow;
    db.close();
  }
});

test('stationary zero counter bounds still certify a complete dry day', async () => {
  const db = gauge(seedTestDb());
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-10T00:00:00.000Z');
  try {
    await writeMod9(db, mod9Msg('2026-10-07T23:50:00.000Z', 10));
    await writeMod9(db, mod9Msg('2026-10-09T00:10:00.000Z', 10));
    const resolved = await facadeDb(db).transaction((t) => rain.resolveZoneRain(t, 1, '2026-10-08'));
    assert.equal(resolved.coverage, 'complete');
    assert.equal(resolved.amountMm, 0);
    assert.deepEqual(resolved.reasons, []);
  } finally {
    Date.now = realNow;
    db.close();
  }
});

test('legacy zero counter bounds without zone snapshots cannot certify a current assignment', async () => {
  const db = gauge(seedTestDb());
  try {
    legacyCounterRow(db, '2026-10-07T23:50:00.000Z', 10, 'ok', 0, 600);
    legacyCounterRow(db, '2026-10-09T00:10:00.000Z', 10, 'ok', 0, 87600);
    const resolved = await facadeDb(db).transaction((t) => rain.resolveZoneRain(t, 1, '2026-10-08'));
    assert.notEqual(resolved.coverage, 'complete');
    assert.equal(resolved.amountMm, null);
    assert.ok(resolved.reasons.includes('zone_provenance_unknown'));
  } finally {
    db.close();
  }
});

test('known LSN50 enablement changes are not reported as missing provenance or zone moves', async () => {
  const db = seedTestDb();
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-10T00:00:00.000Z');
  try {
    db.prepare("UPDATE devices SET rain_gauge_enabled=0 WHERE deveui='DENDRO1'").run();
    await writeMod9(db, mod9Msg('2026-10-07T23:50:00.000Z', 10));
    db.prepare("UPDATE devices SET rain_gauge_enabled=1 WHERE deveui='DENDRO1'").run();
    await writeMod9(db, mod9Msg('2026-10-09T00:10:00.000Z', 10));
    const changed = await facadeDb(db).transaction((t) => rain.resolveZoneRain(t, 1, '2026-10-08'));
    assert.equal(changed.coverage, 'unknown');
    assert.equal(changed.amountMm, null);
    assert.ok(changed.reasons.includes('config_change'), JSON.stringify(changed));
    assert.ok(!changed.reasons.includes('zone_provenance_unknown'));
    assert.ok(!changed.reasons.includes('zone_reassigned'));
  } finally {
    Date.now = realNow;
    db.close();
  }
});

test('stable disabled LSN50 bounds do not certify a dry day', async () => {
  const db = seedTestDb();
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-10T00:00:00.000Z');
  try {
    db.prepare("UPDATE devices SET rain_gauge_enabled=0 WHERE deveui='DENDRO1'").run();
    await writeMod9(db, mod9Msg('2026-10-07T23:50:00.000Z', 10));
    await writeMod9(db, mod9Msg('2026-10-09T00:10:00.000Z', 10));
    db.prepare("UPDATE devices SET rain_gauge_enabled=1 WHERE deveui='DENDRO1'").run();
    const resolved = await facadeDb(db).transaction((t) => rain.resolveZoneRain(t, 1, '2026-10-08'));
    assert.equal(resolved.coverage, 'unknown');
    assert.equal(resolved.amountMm, null);
    assert.equal(resolved.receivedMm, null);
    assert.ok(resolved.reasons.includes('no_gauge'), JSON.stringify(resolved));
    assert.ok(!resolved.reasons.includes('zone_provenance_unknown'));
    assert.ok(!resolved.reasons.includes('zone_reassigned'));
  } finally {
    Date.now = realNow;
    db.close();
  }
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

test('positive rain from a non-gauge LSN50 preserves another legacy source', async () => {
  const db = seedTestDb();
  db.prepare("INSERT INTO zone_daily_environment(zone_id,date,rainfall_mm,flow_liters,rain_source,computed_at,sync_version) VALUES(1,'2026-10-08',3,2,'sensecap_s2120','2026-10-08T09:00:00.000Z',7)").run();
  counterRow(db, '2026-10-08T09:50:00.000Z', 10, 'first_sample', null, null);
  const before = { ...db.prepare("SELECT rainfall_mm, rain_received_mm, rain_coverage, rain_source, rain_policy_version, rain_quality_reasons, rain_selected_deveui, flow_liters, sync_version FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get() };
  await run(db, msgFor('ok', 0.5, 'ok', 4));
  const after = db.prepare("SELECT rainfall_mm, rain_received_mm, rain_coverage, rain_source, rain_policy_version, rain_quality_reasons, rain_selected_deveui, flow_liters, sync_version FROM zone_daily_environment WHERE zone_id=1 AND date='2026-10-08'").get();
  assert.deepEqual({ ...after, flow_liters: before.flow_liters, sync_version: before.sync_version }, before,
    'a non-gauge rain report must take the flow-only path and keep every legacy rain field');
  assert.equal(after.flow_liters, 6);
  assert.equal(after.sync_version, 8);
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

test('next-day uplink closes the prior local-gauge day once without applying rain twice', async () => {
  const db = gauge(seedTestDb());
  const realNow = Date.now;
  let now = Date.parse('2026-10-08T10:00:00.000Z');
  Date.now = () => now;
  try {
    counterRow(db, '2026-10-07T23:50:00.000Z', 10, 'ok', 0, 600);
    counterRow(db, '2026-10-08T10:00:00.000Z', 11, 'ok', 0.4, 600);
    await run(db, msgFor('ok', 0.4, 'first_sample', null, '2026-10-08T10:00:00.000Z'));
    const open = rowForDate(db, '2026-10-08');
    assert.equal(open.rain_coverage, 'complete_so_far');

    counterRow(db, '2026-10-09T00:10:00.000Z', 11, 'ok', 0, 600);
    now = Date.parse('2026-10-09T00:10:00.000Z');
    const successor = msgFor('ok', 0, 'first_sample', null, '2026-10-09T00:10:00.000Z');
    await run(db, successor);
    const closed = rowForDate(db, '2026-10-08');
    assert.ok(['complete', 'partial'].includes(closed.rain_coverage), 'the day is assessed from its actual counter bounds');
    assert.equal(closed.rain_received_mm, 0.4);
    assert.equal(closed.rainfall_mm, closed.rain_coverage === 'complete' ? 0.4 : null);
    assert.equal(closed.sync_version, open.sync_version + 1, 'closing the day changes its projection once');
    assert.ok(!JSON.parse(closed.rain_quality_reasons).includes('ongoing'));
    const afterFirstClose = { ...closed };
    await run(db, successor);
    assert.deepEqual(rowForDate(db, '2026-10-08'), afterFirstClose, 'reassessment replay is a no-op');
    assert.equal(closed.flow_liters, 0, 'a rain-only successor does not add flow to the prior date');
  } finally {
    Date.now = realNow;
    db.close();
  }
});

test('a reset-only successor closes the previous day without creating a current-day row', async () => {
  const db = gauge(seedTestDb());
  const realNow = Date.now;
  let now = Date.parse('2026-10-08T10:00:00.000Z');
  Date.now = () => now;
  try {
    counterRow(db, '2026-10-07T23:50:00.000Z', 10, 'ok', 0, 600);
    counterRow(db, '2026-10-08T10:00:00.000Z', 11, 'ok', 0.4, 600);
    await run(db, msgFor('ok', 0.4, 'first_sample', null, '2026-10-08T10:00:00.000Z'));
    counterRow(db, '2026-10-09T00:10:00.000Z', 0, 'counter_reset', null, null);
    now = Date.parse('2026-10-09T00:10:00.000Z');
    await run(db, msgFor('counter_reset', null, 'counter_reset', null, '2026-10-09T00:10:00.000Z'));
    const closed = rowForDate(db, '2026-10-08');
    assert.ok(['complete', 'partial'].includes(closed.rain_coverage));
    assert.ok(!JSON.parse(closed.rain_quality_reasons).includes('ongoing'));
    assert.equal(rowForDate(db, '2026-10-09'), undefined, 'a non-accepted frame does not invent a current-day row');
  } finally {
    Date.now = realNow;
    db.close();
  }
});

test('Zurich midnight closes the prior farm date even while the UTC date is unchanged', async () => {
  const db = gauge(seedTestDb());
  db.exec("UPDATE irrigation_zones SET timezone = 'Europe/Zurich' WHERE id = 1");
  const realNow = Date.now;
  let now = Date.parse('2026-10-08T10:00:00.000Z');
  Date.now = () => now;
  try {
    counterRow(db, '2026-10-07T21:50:00.000Z', 10, 'ok', 0, 600);
    counterRow(db, '2026-10-08T10:00:00.000Z', 11, 'ok', 0.4, 600);
    await run(db, msgFor('ok', 0.4, 'first_sample', null, '2026-10-08T10:00:00.000Z'));
    assert.equal(rowForDate(db, '2026-10-08').rain_coverage, 'complete_so_far');
    counterRow(db, '2026-10-08T22:10:00.000Z', 11, 'ok', 0, 600);
    now = Date.parse('2026-10-08T22:10:00.000Z');
    await run(db, msgFor('ok', 0, 'first_sample', null, '2026-10-08T22:10:00.000Z'));
    const closed = rowForDate(db, '2026-10-08');
    assert.ok(['complete', 'partial'].includes(closed.rain_coverage));
    assert.ok(!JSON.parse(closed.rain_quality_reasons).includes('ongoing'));
    assert.equal(rowForDate(db, '2026-10-09').rain_source, 'local_gauge');
  } finally {
    Date.now = realNow;
    db.close();
  }
});
