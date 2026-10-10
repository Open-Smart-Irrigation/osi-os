#!/usr/bin/env node
'use strict';

// Behavioural test for the zone rain gauge selection routes
//   GET /api/irrigation-zones/:zone_id/rain-source
//   PUT /api/irrigation-zones/:zone_id/rain-source   body { deveui: string | null }
// The PUT goes through the zone settings guard (scoped-zone-config-guard), the
// GET straight to the handler (zone reads are account-wide in scoped mode, W1).
// Both run the shipped function-node source through the flow-node harness.
//
// Run: node --test scripts/test-zone-rain-source-route.js

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  executeFunction,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');
const scopeHelper = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper'
);

const AUTH_SECRET = 'zone-rain-source-route-test-secret';
const FLAG_OFF = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' };
const FLAG_ON = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '1' };
const OWNER = { userId: 2, username: 'res1' };      // owns zone 1 ('Z One')
const STRANGER = { userId: 1, username: 'admin1' }; // owns zone 2
const VIEWER = { userId: 3, username: 'view1' };    // granted zone 1, cannot mutate

const LORAIN = 'A840410000000001';
const S2120 = 'A840410000000002';
const OTHER_ZONE_GAUGE = 'A840410000000003';
const LSN50 = 'A840410000000004';
const GUARD_ROUTE_INDEX = 4;

// Zone 1 gets two gauges: a LoRain in the zone and an S2120 weather station
// that serves it through weather_station_zones. Zone 2 gets its own LoRain
// beside the seeded S2120 'WX1'.
function seedGauges(db) {
  db.exec(`
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) VALUES
      ('${LORAIN}', 'Gauge north', 'AQUASCOPE_LORAIN', 2, 1, '2026-01-01', '2026-01-01'),
      ('${S2120}', 'Station east', 'SENSECAP_S2120', 2, NULL, '2026-01-01', '2026-01-01'),
      ('${OTHER_ZONE_GAUGE}', 'Gauge south', 'AQUASCOPE_LORAIN', 1, 2, '2026-01-01', '2026-01-01');
    INSERT INTO weather_station_zones (deveui, zone_id) VALUES ('${S2120}', 1);
  `);
}

function addLsn50Gauge(db) {
  db.prepare('INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, rain_gauge_enabled, created_at, updated_at) '
    + "VALUES (?, 'Counter gauge', 'DRAGINO_LSN50', 2, 1, 1, '2026-01-01', '2026-01-01')").run(LSN50);
}

// Seed the same raw-row plus immutable 0071 attribution shape produced by the
// LSN50 Normalize + Write transaction. Each frame covers the preceding four
// hours; `changeAtIndex` alters the saved owner or enablement before that frame.
function seedLsn50Day(db, day, { changeAtIndex = -1, change = null, disabled = false } = {}) {
  const start = Date.parse(day + 'T00:00:00.000Z');
  const state = { zoneId: 1, enabled: !disabled };
  let cumulative = 10;
  const times = [start - 4 * 3600000];
  for (let hour = 0; hour <= 24; hour += 4) times.push(start + hour * 3600000);
  times.forEach((time, index) => {
    if (index === changeAtIndex) {
      if (change && Object.hasOwn(change, 'zoneId')) state.zoneId = change.zoneId;
      if (change && Object.hasOwn(change, 'enabled')) state.enabled = change.enabled;
      db.prepare('UPDATE devices SET irrigation_zone_id = ?, rain_gauge_enabled = ? WHERE deveui = ?')
        .run(state.zoneId, state.enabled ? 1 : 0, LSN50);
    }
    const amount = index === 4 ? 2 : 0;
    cumulative += amount;
    const receivedAt = new Date(time).toISOString();
    const inserted = db.prepare('INSERT INTO device_data (deveui, recorded_at, rain_count_cumulative, rain_mm_delta, rain_delta_status, counter_interval_seconds) '
      + "VALUES (?, ?, ?, ?, 'ok', ?)").run(LSN50, receivedAt, cumulative, amount, 14400);
    const zone = state.zoneId === null ? null : db.prepare('SELECT zone_uuid, timezone FROM irrigation_zones WHERE id = ?').get(state.zoneId);
    const zones = zone ? [state.zoneId] : [];
    const config = {
      frame: { rain_count_cumulative: cumulative, rain_mm_delta: amount, rain_delta_status: 'ok', counter_interval_seconds: 14400 },
      zones,
      zone_snapshots: zone ? [{ zone_id: state.zoneId, zone_uuid: zone.zone_uuid, timezone: zone.timezone }] : [],
      rain_gauge_enabled: state.enabled,
    };
    db.prepare('INSERT INTO rain_observations (device_data_id, deveui, instrument_type, payload_digest, received_at, measured_start, measured_end, interval_basis, frame_kind, amount_mm, status, quality_reasons, config_json, zone_id, zone_uuid, timezone) '
      + "VALUES (?, ?, 'DRAGINO_LSN50', ?, ?, ?, ?, 'protocol_verified', 'counter', ?, 'accepted', '[]', ?, ?, ?, ?)")
      .run(Number(inserted.lastInsertRowid), LSN50, '0'.repeat(64), receivedAt,
        new Date(time - 14400 * 1000).toISOString(), receivedAt, amount, JSON.stringify(config),
        zone ? state.zoneId : null, zone ? zone.zone_uuid : null, zone ? zone.timezone : 'UTC');
  });
}

function seedProjectedRow(db, day) {
  db.prepare('INSERT INTO zone_daily_environment (zone_id, date, rainfall_mm, rain_received_mm, rain_coverage, rain_selected_deveui, rain_policy_version, rain_quality_reasons, rain_source, flow_liters, computed_at, sync_version) '
    + "VALUES (1, ?, NULL, NULL, 'unknown', NULL, 1, '[\"gauge_ambiguous\"]', 'none', 4, ?, 3)")
    .run(day, day + 'T23:00:00.000Z');
}

function token(identity) {
  return makeAuthHeader({ userId: identity.userId, username: identity.username, secret: AUTH_SECRET });
}

function request({ method, zoneId = 1, body, authorization }) {
  return {
    req: {
      method,
      path: '/api/irrigation-zones/' + zoneId + '/rain-source',
      headers: authorization === undefined ? {} : { authorization },
      params: { zone_id: String(zoneId) },
      query: {},
      body: body === undefined ? {} : body,
    },
  };
}

async function getRoute(db, env, options) {
  scopeHelper._resetForTests();
  const handler = await executeFunction(loadNode('zone-rain-source-fn'), {
    msg: request({ method: 'GET', ...options }),
    env,
    db,
  });
  return handler.result;
}

async function putRoute(db, env, options) {
  scopeHelper._resetForTests();
  const guard = await executeFunction(loadNode('scoped-zone-config-guard'), {
    msg: request({ method: 'PUT', ...options }),
    env,
    db,
  });
  const failed = guard.result[guard.result.length - 1];
  if (failed) return { stage: 'guard', result: failed };
  const passed = guard.result[GUARD_ROUTE_INDEX];
  assert.ok(passed, 'the guard must pass the rain-source PUT on its own output');
  const handler = await executeFunction(loadNode('zone-rain-source-fn'), { msg: passed, env, db });
  return { stage: 'handler', result: handler.result };
}

function storedSelection(db, zoneId = 1) {
  return db.prepare('SELECT selected_deveui, selected_by_uuid FROM zone_rain_source WHERE zone_id = ?').get(zoneId);
}

test('flag-off: the owner reads an ambiguous zone with both candidates and the suggestion', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const result = await getRoute(db, FLAG_OFF, { authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.deepEqual(result.payload, {
      state: 'ambiguous',
      selected_deveui: null,
      basis: null,
      candidates: [
        { deveui: LORAIN, name: 'Gauge north', type_id: 'AQUASCOPE_LORAIN', via: 'direct' },
        { deveui: S2120, name: 'Station east', type_id: 'SENSECAP_S2120', via: 'weather_station' },
      ],
      suggested_deveui: LORAIN,
    });
  } finally {
    db.close();
  }
});

test('flag-off: a zone with one gauge reads as selected, basis only_candidate', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    db.exec("DELETE FROM weather_station_zones WHERE deveui = '" + S2120 + "'");
    const result = await getRoute(db, FLAG_OFF, { authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.state, 'selected');
    assert.equal(result.payload.selected_deveui, LORAIN);
    assert.equal(result.payload.basis, 'only_candidate');
    assert.equal(result.payload.suggested_deveui, null);
  } finally {
    db.close();
  }
});

test('flag-off: a foreign zone answers 404 on read and on write, and nothing is stored', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const read = await getRoute(db, FLAG_OFF, { authorization: token(STRANGER) });
    assert.equal(read.statusCode, 404, JSON.stringify(read.payload));
    const write = await putRoute(db, FLAG_OFF, { body: { deveui: LORAIN }, authorization: token(STRANGER) });
    assert.equal(write.result.statusCode, 404, JSON.stringify(write.result.payload));
    assert.equal(storedSelection(db), undefined);
  } finally {
    db.close();
  }
});

test('no Authorization header answers 401 on read and on write', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const read = await getRoute(db, FLAG_OFF, { authorization: undefined });
    assert.equal(read.statusCode, 401, JSON.stringify(read.payload));
    const write = await putRoute(db, FLAG_OFF, { body: { deveui: LORAIN }, authorization: undefined });
    assert.equal(write.result.statusCode, 401, JSON.stringify(write.result.payload));
    assert.equal(storedSelection(db), undefined);
  } finally {
    db.close();
  }
});

test('flag-off: the owner selects a candidate; the read then shows it as explicit', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const { stage, result } = await putRoute(db, FLAG_OFF, { body: { deveui: S2120.toLowerCase() }, authorization: token(OWNER) });
    assert.equal(stage, 'handler');
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.state, 'selected');
    assert.equal(result.payload.selected_deveui, S2120);
    assert.equal(result.payload.basis, 'explicit');
    assert.equal(storedSelection(db).selected_deveui, S2120);
    assert.equal(storedSelection(db).selected_by_uuid, 'u-res1');
    const read = await getRoute(db, FLAG_OFF, { authorization: token(OWNER) });
    assert.equal(read.payload.selected_deveui, S2120);
    assert.equal(read.payload.basis, 'explicit');
  } finally {
    db.close();
  }
});

test('flag-off: null clears the selection and the zone is ambiguous again', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    await putRoute(db, FLAG_OFF, { body: { deveui: LORAIN }, authorization: token(OWNER) });
    const { result } = await putRoute(db, FLAG_OFF, { body: { deveui: null }, authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.state, 'ambiguous');
    assert.equal(result.payload.selected_deveui, null);
    assert.equal(result.payload.suggested_deveui, LORAIN);
    assert.equal(storedSelection(db).selected_deveui, null);
  } finally {
    db.close();
  }
});

for (const [label, body] of [
  ['a gauge of another zone', { deveui: OTHER_ZONE_GAUGE }],
  ['a device that is not a gauge', { deveui: 'DENDRO1' }],
  ['an unknown device', { deveui: 'A8404100000000FF' }],
  ['an empty string', { deveui: '' }],
  ['a number', { deveui: 42 }],
  ['a body without deveui', {}],
]) {
  test('flag-off: ' + label + ' answers 400 and stores nothing', async () => {
    const db = seedScopedDb();
    seedGauges(db);
    try {
      const { result } = await putRoute(db, FLAG_OFF, { body, authorization: token(OWNER) });
      assert.equal(result.statusCode, 400, JSON.stringify(result.payload));
      assert.equal(typeof result.payload.error, 'string');
      assert.equal(storedSelection(db), undefined);
    } finally {
      db.close();
    }
  });
}

test('scoped: a viewer reads the selection of a zone (account-wide read)', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const own = await getRoute(db, FLAG_ON, { authorization: token(VIEWER) });
    assert.equal(own.statusCode, 200, JSON.stringify(own.payload));
    assert.equal(own.payload.state, 'ambiguous');
    const other = await getRoute(db, FLAG_ON, { zoneId: 2, authorization: token(VIEWER) });
    assert.equal(other.statusCode, 200, JSON.stringify(other.payload));
  } finally {
    db.close();
  }
});

test('scoped: a viewer is refused 403 on write before anything is stored', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const { stage, result } = await putRoute(db, FLAG_ON, { body: { deveui: LORAIN }, authorization: token(VIEWER) });
    assert.equal(stage, 'guard');
    assert.equal(result.statusCode, 403, JSON.stringify(result.payload));
    assert.equal(storedSelection(db), undefined);
  } finally {
    db.close();
  }
});

test('scoped: a researcher with no grant on the zone is refused without a write', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    db.exec("UPDATE user_zone_assignments SET deleted_at='2026-09-20T00:00:00Z' WHERE assignment_uuid='g-3'");
    const { stage, result } = await putRoute(db, FLAG_ON, { zoneId: 2, body: { deveui: OTHER_ZONE_GAUGE }, authorization: token(OWNER) });
    assert.equal(stage, 'guard');
    assert.ok(result.statusCode === 403 || result.statusCode === 404, String(result.statusCode));
    assert.equal(storedSelection(db, 2), undefined);
  } finally {
    db.close();
  }
});

test('scoped: a granted researcher selects the gauge of a zone it does not own', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const { stage, result } = await putRoute(db, FLAG_ON, { zoneId: 2, body: { deveui: OTHER_ZONE_GAUGE }, authorization: token(OWNER) });
    assert.equal(stage, 'handler');
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(storedSelection(db, 2).selected_deveui, OTHER_ZONE_GAUGE);
    assert.equal(storedSelection(db, 2).selected_by_uuid, 'u-res1');
  } finally {
    db.close();
  }
});

test('scoped: a disabled account cannot read', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    db.exec("UPDATE users SET disabled_at = '2026-01-01T00:00:00.000Z' WHERE user_uuid = 'u-view1'");
    const result = await getRoute(db, FLAG_ON, { authorization: token(VIEWER) });
    assert.equal(result.statusCode, 403, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

test('scoped: a missing zone answers 404 on read', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const result = await getRoute(db, FLAG_ON, { zoneId: 999, authorization: token(STRANGER) });
    assert.equal(result.statusCode, 404, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

test('scoped: the handler called without the guard marker refuses the write', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    scopeHelper._resetForTests();
    const { result } = await executeFunction(loadNode('zone-rain-source-fn'), {
      msg: request({ method: 'PUT', body: { deveui: LORAIN }, authorization: token(OWNER) }),
      env: FLAG_ON,
      db,
    });
    assert.equal(result.statusCode, 403, JSON.stringify(result.payload));
    assert.equal(storedSelection(db), undefined);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// A selection re-projects the zone's last 30 farm days (Task 2)
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { facadeDb } = require('./lib/scoped-access-harness');

const NODE_RED = path.join(__dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const R = require(path.join(NODE_RED, 'osi-rain/index.js'));
const CODEC = path.join(NODE_RED, 'codecs/aquascope_lorain_decoder.js');
// The frames below report FPort 2, build 241015; the test pins that build so
// the gauges' days can be complete (the shipped pinned set is empty, D9).
const PINNED = [{ fPort: 2, buildDate: '241015' }];
const JOIN_HEX = '0a0003ad7703050001040403840402001006030000060100b8068100001221000a';
const rainHex = (tips) => '06030000060100b8068100' + tips.toString(16).padStart(2, '0') + '1221000a';
const decodeUplink = (() => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODEC, 'utf8'), sandbox, { filename: CODEC });
  return sandbox.decodeUplink;
})();

let eventSeq = 0;
// One complete UTC day of a promoted LoRain: join the evening before, a frame
// every 4 h, `noonTips` tips at noon, and the frame after midnight that closes it.
async function completeLoRainDay(db, eui, day, { noonTips, devAddr, fCntBase }) {
  const dayMs = Date.parse(day + 'T00:00:00.000Z');
  const times = [dayMs - 4 * 3600000];
  for (let h = 0; h <= 24; h += 4) times.push(dayMs + h * 3600000);
  for (let i = 0; i < times.length; i += 1) {
    eventSeq += 1;
    const bytes = Buffer.from(i === 0 ? JOIN_HEX : rainHex(i === 4 ? noonTips : 0), 'hex');
    const object = decodeUplink({ fPort: 2, bytes }).data;
    await facadeDb(db).transaction((t) => R.ingestLoRainUplink(t, {
      deveui: eui, eventId: '00000000-0000-4000-8000-' + String(eventSeq).padStart(12, '0'), devAddr, fCnt: fCntBase + i,
      time: new Date(times[i]).toISOString(), fPort: 2, data: bytes.toString('base64'), object,
    }, { nowMs: Date.now(), pinnedBuilds: PINNED }));
  }
}

const utcDay = (offsetDays) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
const zoneDay = (db, date) => {
  const row = db.prepare('SELECT rainfall_mm, rain_received_mm, rain_coverage, rain_selected_deveui, rain_source, '
    + 'rain_quality_reasons, sync_version FROM zone_daily_environment WHERE zone_id = 1 AND date = ?').get(date);
  return row ? { ...row } : row;
};

test('selecting a gauge re-projects the last 30 days to its complete days; older days stay as they are', async (t) => {
  const db = seedScopedDb();
  try {
    // Two LoRain gauges in zone 1 (UTC); no weather station.
    db.exec(`INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) VALUES
      ('${LORAIN}', 'Gauge north', 'AQUASCOPE_LORAIN', 2, 1, '2026-01-01', '2026-01-01'),
      ('${OTHER_ZONE_GAUGE}', 'Gauge west', 'AQUASCOPE_LORAIN', 2, 1, '2026-01-01', '2026-01-01');`);
    const recent = [utcDay(3), utcDay(12), utcDay(29)];
    const old = utcDay(40);
    let fCnt = 0;
    for (const day of [old, ...recent].sort()) {
      await completeLoRainDay(db, LORAIN, day, { noonTips: 10, devAddr: '01000001', fCntBase: fCnt });
      await completeLoRainDay(db, OTHER_ZONE_GAUGE, day, { noonTips: 6, devAddr: '01000002', fCntBase: fCnt });
      fCnt += 10;
    }
    const before = Object.fromEntries([old, ...recent].map((d) => [d, zoneDay(db, d)]));
    for (const d of [old, ...recent]) {
      assert.deepEqual([before[d].rainfall_mm, before[d].rain_coverage, before[d].rain_selected_deveui], [null, 'unknown', null], d);
      assert.deepEqual(JSON.parse(before[d].rain_quality_reasons), ['gauge_ambiguous'], d);
    }

    const started = process.hrtime.bigint();
    const { result } = await putRoute(db, FLAG_OFF, { body: { deveui: OTHER_ZONE_GAUGE }, authorization: token(OWNER) });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    t.diagnostic('PUT rain-source with a 30-day re-projection took ' + elapsedMs.toFixed(1) + ' ms on the harness');
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.selected_deveui, OTHER_ZONE_GAUGE);

    for (const d of recent) {
      const row = zoneDay(db, d);
      assert.deepEqual([row.rainfall_mm, row.rain_received_mm, row.rain_coverage, row.rain_selected_deveui, row.rain_source],
        [3, 3, 'complete', OTHER_ZONE_GAUGE, 'aquascope_lorain'], 'the selected gauge alone, never 5 + 3: ' + d);
      assert.deepEqual(JSON.parse(row.rain_quality_reasons), [], d);
      assert.equal(row.sync_version, before[d].sync_version + 1, 'one version step per re-projected day: ' + d);
    }
    assert.deepEqual(zoneDay(db, old), before[old], 'a day outside the 30-day window is not re-projected');

    // Selecting the same gauge again changes nothing.
    await putRoute(db, FLAG_OFF, { body: { deveui: OTHER_ZONE_GAUGE }, authorization: token(OWNER) });
    for (const d of recent) assert.equal(zoneDay(db, d).sync_version, before[d].sync_version + 1, d);

    // Clearing the choice makes the recent days ambiguous again.
    await putRoute(db, FLAG_OFF, { body: { deveui: null }, authorization: token(OWNER) });
    for (const d of recent) {
      const row = zoneDay(db, d);
      assert.deepEqual([row.rainfall_mm, row.rain_coverage, row.rain_selected_deveui], [null, 'unknown', null], d);
      assert.deepEqual(JSON.parse(row.rain_quality_reasons), ['gauge_ambiguous'], d);
    }
  } finally {
    db.close();
  }
});

test('a selection inserts no zone day for a date that has none (A31)', async () => {
  const db = seedScopedDb();
  seedGauges(db);
  try {
    const { result } = await putRoute(db, FLAG_OFF, { body: { deveui: LORAIN }, authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM zone_daily_environment WHERE zone_id = 1').get().n, 0);
  } finally {
    db.close();
  }
});

test('selection re-projection retains LSN50 snapshot quality and leaves a nonselected legacy row intact', async () => {
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-10-10T03:00:00.000Z');
  try {
    const day = '2026-10-08';
    const legacyDay = '2026-10-09';
    const scenarios = [
      { name: 'stable enabled gauge', seed: {}, expected: [2, 2, 'complete'], reason: null },
      { name: 'known zone move', seed: { changeAtIndex: 5, change: { zoneId: 2 } }, expected: [null, 2, 'partial'], reason: 'zone_reassigned' },
      { name: 'known enablement change', seed: { changeAtIndex: 5, change: { enabled: false } }, expected: [null, 2, 'unknown'], reason: 'config_change' },
      { name: 'stable disabled gauge', seed: { disabled: true }, expected: [null, null, 'unknown'], reason: 'no_gauge' },
      { name: 'missing boundary provenance', seed: { missingBoundary: true }, expected: [null, 2, 'unknown'], reason: 'zone_provenance_unknown' },
    ];
    for (const scenario of scenarios) {
      const db = seedScopedDb();
      try {
        seedGauges(db);
        addLsn50Gauge(db);
        seedLsn50Day(db, day, scenario.seed);
        if (scenario.seed.missingBoundary) {
          const boundary = new Date(Date.parse(day + 'T00:00:00.000Z') - 4 * 3600000).toISOString();
          db.prepare('DELETE FROM rain_observations WHERE device_data_id = '
            + '(SELECT id FROM device_data WHERE deveui = ? AND recorded_at = ?)').run(LSN50, boundary);
        }
        seedProjectedRow(db, day);
        db.prepare('INSERT INTO zone_daily_environment (zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at, sync_version) '
          + "VALUES (1, ?, 3.5, 4, 'sensecap_s2120', ?, 9)")
          .run(legacyDay, legacyDay + 'T23:00:00.000Z');
        const legacyBefore = { ...db.prepare('SELECT * FROM zone_daily_environment WHERE zone_id = 1 AND date = ?').get(legacyDay) };
        // The current candidate remains eligible even when historical frames
        // record a disabled period or a different zone assignment.
        db.prepare('UPDATE devices SET irrigation_zone_id = 1, rain_gauge_enabled = 1 WHERE deveui = ?').run(LSN50);

        const { result } = await putRoute(db, FLAG_OFF, { body: { deveui: LSN50 }, authorization: token(OWNER) });
        assert.equal(result.statusCode, 200, scenario.name + ': ' + JSON.stringify(result.payload));
        assert.equal(result.payload.selected_deveui, LSN50);
        const projected = zoneDay(db, day);
        assert.deepEqual([projected.rainfall_mm, projected.rain_received_mm, projected.rain_coverage], scenario.expected, scenario.name);
        assert.equal(projected.rain_selected_deveui, LSN50, scenario.name);
        const reasons = JSON.parse(projected.rain_quality_reasons);
        if (scenario.reason) assert.ok(reasons.includes(scenario.reason), scenario.name + ': ' + JSON.stringify(reasons));
        else assert.deepEqual(reasons, [], scenario.name);

        const legacyAfter = { ...db.prepare('SELECT * FROM zone_daily_environment WHERE zone_id = 1 AND date = ?').get(legacyDay) };
        assert.deepEqual(legacyAfter, legacyBefore, scenario.name + ': NULL-coverage history from a nonselected source remains unchanged');
      } finally {
        db.close();
      }
    }
  } finally {
    Date.now = realNow;
  }
});
