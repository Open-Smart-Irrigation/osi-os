#!/usr/bin/env node
'use strict';

// Behavioural test for the farm day of the latest rain value in GET /api/devices
// (merge-device-data, "Merge Data").
//
// The rain "today" tiles used to show the stored rain_mm_today without its day,
// so a total reported at 23:50 still read "Today" the next morning. The device
// list now dates the latest row of every rain-capable device (LoRain, S2120,
// LSN50 with the rain gauge enabled) in the farm timezone: latest_data.rain_day
// (YYYY-MM-DD), rain_day_timezone and rain_day_timezone_basis. The browser
// never decides the day.
//
// The harness resolves an osiLib name it does not know as `osi-<name>`, which
// hid #564: no osi-lib registry listed 'history-helper', so on a gateway the
// lookup failed and the three fields were never sent. The production-registry
// tests below load each profile's own osi-lib and run that profile's Merge Data.
//
// Run: node --test scripts/test-device-list-rain-day.js

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { executeFunction, facadeDb, loadNode, seedTestDb } = require('./lib/flow-node-harness');

const HISTORY_HELPER = path.join(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share',
  'node-red', 'osi-history-helper', 'index.js');

const PROFILES = ['bcm2712', 'bcm2709'].map((soc) => {
  const share = path.join(__dirname, '..', 'conf', `full_raspberrypi_bcm27xx_${soc}`, 'files', 'usr', 'share');
  return { soc, flows: path.join(share, 'flows.json'), nodeRed: path.join(share, 'node-red') };
});

const LORAIN = 'A840410000000001';
const S2120 = 'A840410000000002';
const LSN50_RAIN = 'A840410000000003';
const KIWI = 'A840410000000004';
const LSN50_PLAIN = 'A840410000000005';
const LORAIN_CET = 'A840410000000006';

function seed() {
  const db = seedTestDb();
  db.exec(`
    INSERT INTO irrigation_zones (id, name, user_id, zone_uuid, timezone, scheduling_mode) VALUES
      (10, 'Farm', 1, 'z-farm', 'Europe/Zurich', 'local'),
      (11, 'Abbrev', 1, 'z-abbrev', 'CET', 'local');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, rain_gauge_enabled, created_at, updated_at) VALUES
      ('${LORAIN}', 'Gauge', 'AQUASCOPE_LORAIN', 1, 10, 0, '2026-01-01', '2026-01-01'),
      ('${S2120}', 'Station', 'SENSECAP_S2120', 1, NULL, 0, '2026-01-01', '2026-01-01'),
      ('${LSN50_RAIN}', 'Node rain', 'DRAGINO_LSN50', 1, NULL, 1, '2026-01-01', '2026-01-01'),
      ('${KIWI}', 'Soil', 'KIWI_SENSOR', 1, 10, 0, '2026-01-01', '2026-01-01'),
      ('${LSN50_PLAIN}', 'Node', 'DRAGINO_LSN50', 1, 10, 0, '2026-01-01', '2026-01-01'),
      ('${LORAIN_CET}', 'Gauge 2', 'AQUASCOPE_LORAIN', 1, 11, 0, '2026-01-01', '2026-01-01');
    INSERT INTO weather_station_zones (deveui, zone_id) VALUES ('${S2120}', 10);
  `);
  return db;
}

// The rows format-devices hands on (SELECT d.* ... from devices) in the shape merge-device-data reads.
function formattedDevices(db) {
  return db.prepare('SELECT deveui, name, type_id, irrigation_zone_id, rain_gauge_enabled FROM devices WHERE deveui LIKE ? ORDER BY deveui')
    .all('A8404100%');
}

const LATEST = [
  // 22:30Z on July 1 is 00:30 on July 2 in Zurich.
  { deveui: LORAIN, last_uplink_at: '2026-07-01T22:30:00.000Z', rain_mm_today: 1.2 },
  { deveui: S2120, last_uplink_at: '2026-07-01T22:30:00.000Z', rain_mm_today: 4.0 },
  // SQLite's zone-less form is UTC, whatever the gateway host's timezone is.
  { deveui: LSN50_RAIN, last_uplink_at: '2026-07-01 23:30:00', rain_mm_today: 0.4 },
  { deveui: KIWI, last_uplink_at: '2026-07-01T22:30:00.000Z' },
  { deveui: LSN50_PLAIN, last_uplink_at: '2026-07-01T22:30:00.000Z' },
  // CET is accepted by Intl (UTC+2 in July) but flagged as an abbreviation.
  { deveui: LORAIN_CET, last_uplink_at: '2026-07-01T22:30:00.000Z', rain_mm_today: 0.2 },
];

async function runMerge(db, options = {}) {
  const node = loadNode('merge-device-data');
  const msg = { devices_to_format: formattedDevices(db), payload: LATEST.map((row) => ({ ...row })) };
  const out = await executeFunction(node, { msg, db, ...options });
  const byEui = new Map(out.result.payload.map((device) => [device.deveui, device]));
  return { out, byEui };
}

test('the device list dates the latest rain value in the farm timezone', async () => {
  const db = seed();
  try {
    const { out, byEui } = await runMerge(db);
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.warnings, []);

    const lorain = byEui.get(LORAIN).latest_data;
    assert.equal(lorain.rain_day, '2026-07-02');
    assert.equal(lorain.rain_day_timezone, 'Europe/Zurich');
    assert.equal(lorain.rain_day_timezone_basis, 'zone');

    const station = byEui.get(S2120).latest_data;
    assert.equal(station.rain_day, '2026-07-02');
    assert.equal(station.rain_day_timezone, 'Europe/Zurich');
    assert.equal(station.rain_day_timezone_basis, 'weather_station_zone');

    const node = byEui.get(LSN50_RAIN).latest_data;
    assert.equal(node.rain_day, '2026-07-01');
    assert.equal(node.rain_day_timezone, 'UTC');
    assert.equal(node.rain_day_timezone_basis, 'unassigned_default');

    const cet = byEui.get(LORAIN_CET).latest_data;
    assert.equal(cet.rain_day, '2026-07-02');
    assert.equal(cet.rain_day_timezone, 'CET');
    assert.equal(cet.rain_day_timezone_basis, 'abbreviation');
  } finally {
    db.close();
  }
});

test('devices without a rain gauge get no rain day', async () => {
  const db = seed();
  try {
    const { byEui } = await runMerge(db);
    for (const eui of [KIWI, LSN50_PLAIN]) {
      const latest = byEui.get(eui).latest_data;
      assert.equal('rain_day' in latest, false, eui);
      assert.equal('rain_day_timezone' in latest, false, eui);
      assert.equal('rain_day_timezone_basis' in latest, false, eui);
    }
  } finally {
    db.close();
  }
});

test('a rain device without a latest row gets no rain day', async () => {
  const db = seed();
  try {
    const node = loadNode('merge-device-data');
    const msg = { devices_to_format: formattedDevices(db), payload: [] };
    const out = await executeFunction(node, { msg, db });
    const lorain = out.result.payload.find((device) => device.deveui === LORAIN).latest_data;
    assert.equal('rain_day' in lorain, false);
    assert.deepEqual(out.warnings, []);
  } finally {
    db.close();
  }
});

test('one batched timezone lookup for all rain devices', async () => {
  const db = seed();
  try {
    const helper = require(HISTORY_HELPER); // eslint-disable-line global-require
    const calls = [];
    const counting = {
      ...helper,
      resolveDeviceTimezones: async (handle, deveuis, options) => {
        calls.push(deveuis.slice());
        return helper.resolveDeviceTimezones(handle, deveuis, options);
      },
    };
    await runMerge(db, { osiLibModules: { 'history-helper': counting } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice().sort(), [LORAIN, S2120, LSN50_RAIN, LORAIN_CET].sort());
  } finally {
    db.close();
  }
});

test('a failed lookup leaves the fields absent and warns once, the list still answers', async () => {
  const db = seed();
  try {
    const failing = { resolveDeviceTimezones: async () => { throw new Error('database is locked'); } };
    const { out, byEui } = await runMerge(db, { osiLibModules: { 'history-helper': failing } });
    assert.equal(out.result.statusCode, 200);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /rain_day/);
    assert.match(out.warnings[0], /database is locked/);
    for (const eui of [LORAIN, S2120, LSN50_RAIN, LORAIN_CET]) {
      assert.equal('rain_day' in byEui.get(eui).latest_data, false, eui);
    }
    assert.equal(byEui.get(LORAIN).latest_data.rain_mm_today, 1.2);
  } finally {
    db.close();
  }
});

test('an unloadable history helper leaves the fields absent and warns once', async () => {
  const db = seed();
  try {
    const node = loadNode('merge-device-data');
    const msg = { devices_to_format: formattedDevices(db), payload: LATEST.map((row) => ({ ...row })) };
    const osiLib = {
      require: (name) => (name === 'history-helper'
        ? { ok: false, error: 'quarantined' }
        : { ok: false, error: 'not needed' }),
    };
    const out = await executeFunction(node, { msg, db, libOverrides: { osiLib } });
    const rainWarnings = out.warnings.filter((w) => /rain_day/.test(w));
    assert.equal(rainWarnings.length, 1);
    assert.equal('rain_day' in out.result.payload.find((device) => device.deveui === LORAIN).latest_data, false);
  } finally {
    db.close();
  }
});

// A fresh copy of the profile's osi-lib with its gateway base pointed at the
// profile's node-red tree: the real NAME_TO_PATH and the real loader, never the
// harness's `osi-<name>` fallback. Every name the node asks for is recorded.
function productionOsiLib(profile) {
  const index = path.join(profile.nodeRed, 'osi-lib', 'index.js');
  const savedBase = process.env.OSI_LIB_BASE;
  process.env.OSI_LIB_BASE = profile.nodeRed;
  delete require.cache[require.resolve(index)];
  let lib;
  try {
    lib = require(index); // eslint-disable-line global-require
  } finally {
    if (savedBase === undefined) delete process.env.OSI_LIB_BASE;
    else process.env.OSI_LIB_BASE = savedBase;
    delete require.cache[require.resolve(index)];
  }
  const requested = [];
  return {
    requested,
    osiLib: {
      require(name) {
        const result = lib.require(name);
        requested.push({ name, result });
        return result;
      },
    },
  };
}

// osiDb whose handles count their closes; every handle shares the in-memory db.
function countingOsiDb(db) {
  const handles = { opened: [], closed: 0 };
  function Database(file) {
    handles.opened.push(file);
    const facade = facadeDb(db);
    return {
      ...facade,
      close(callback) {
        handles.closed += 1;
        return facade.close(callback);
      },
    };
  }
  return { handles, osiDb: { Database } };
}

async function runProductionMerge(profile, db, latest = LATEST) {
  const node = loadNode('merge-device-data', profile.flows);
  const { requested, osiLib } = productionOsiLib(profile);
  const { handles, osiDb } = countingOsiDb(db);
  const msg = { devices_to_format: formattedDevices(db), payload: latest.map((row) => ({ ...row })) };
  const out = await executeFunction(node, { msg, db, libOverrides: { osiLib, osiDb } });
  const byEui = new Map(out.result.payload.map((device) => [device.deveui, device]));
  return { out, byEui, requested, handles };
}

function assertRainDay(latest, day, timezone, basis, label) {
  assert.equal(latest.rain_day, day, label);
  assert.equal(latest.rain_day_timezone, timezone, label);
  assert.equal(latest.rain_day_timezone_basis, basis, label);
}

function assertNoRainDay(latest, label) {
  for (const field of ['rain_day', 'rain_day_timezone', 'rain_day_timezone_basis']) {
    assert.equal(field in latest, false, `${label}: ${field}`);
  }
}

for (const profile of PROFILES) {
  test(`${profile.soc}: Merge Data dates rain through the production osi-lib registry`, async () => {
    const db = seed();
    try {
      const { out, byEui, requested, handles } = await runProductionMerge(profile, db);
      assert.deepEqual(out.errors, []);
      assert.deepEqual(out.warnings, []);
      assert.equal(out.result.statusCode, 200);

      const history = requested.filter((call) => call.name === 'history-helper');
      assert.equal(history.length, 1);
      assert.equal(history[0].result.ok, true, history[0].result.error);
      // eslint-disable-next-line global-require
      assert.equal(history[0].result.value, require(path.join(profile.nodeRed, 'osi-history-helper')));

      assertRainDay(byEui.get(LORAIN).latest_data, '2026-07-02', 'Europe/Zurich', 'zone', 'LoRain');
      assertRainDay(byEui.get(S2120).latest_data, '2026-07-02', 'Europe/Zurich', 'weather_station_zone', 'S2120');
      assertRainDay(byEui.get(LSN50_RAIN).latest_data, '2026-07-01', 'UTC', 'unassigned_default', 'LSN50 rain');
      assertRainDay(byEui.get(LORAIN_CET).latest_data, '2026-07-02', 'CET', 'abbreviation', 'LoRain CET');
      assertNoRainDay(byEui.get(KIWI).latest_data, 'KIWI');
      assertNoRainDay(byEui.get(LSN50_PLAIN).latest_data, 'LSN50 without rain gauge');

      assert.equal(byEui.get(LORAIN).latest_data.rain_mm_today, 1.2);
      assert.equal(byEui.get(S2120).latest_data.rain_mm_today, 4.0);
      assert.equal(byEui.get(LSN50_RAIN).latest_data.rain_mm_today, 0.4);

      // S2120 zone enrichment and the rain lookup each open and close one handle.
      assert.deepEqual(handles.opened, ['/data/db/farming.db', '/data/db/farming.db']);
      assert.equal(handles.closed, handles.opened.length);
    } finally {
      db.close();
    }
  });

  test(`${profile.soc}: production registry keeps a null amount null and a real zero zero`, async () => {
    const db = seed();
    try {
      const latest = LATEST.map((row) => {
        if (row.deveui === LORAIN) return { ...row, rain_mm_today: null };
        if (row.deveui === S2120) return { ...row, rain_mm_today: 0 };
        return row;
      });
      const { out, byEui } = await runProductionMerge(profile, db, latest);
      assert.deepEqual(out.warnings, []);
      assert.equal(byEui.get(LORAIN).latest_data.rain_mm_today, null);
      assertRainDay(byEui.get(LORAIN).latest_data, '2026-07-02', 'Europe/Zurich', 'zone', 'LoRain null amount');
      assert.equal(byEui.get(S2120).latest_data.rain_mm_today, 0);
      assertRainDay(byEui.get(S2120).latest_data, '2026-07-02', 'Europe/Zurich', 'weather_station_zone', 'S2120 zero');
    } finally {
      db.close();
    }
  });

  test(`${profile.soc}: production registry leaves an invalid or missing timestamp undated`, async () => {
    const db = seed();
    try {
      const latest = LATEST
        .filter((row) => row.deveui !== S2120)
        .map((row) => (row.deveui === LORAIN ? { ...row, last_uplink_at: 'not-a-timestamp' } : row));
      const { out, byEui, handles } = await runProductionMerge(profile, db, latest);
      assert.deepEqual(out.warnings, []);
      assertNoRainDay(byEui.get(LORAIN).latest_data, 'invalid timestamp');
      assertNoRainDay(byEui.get(S2120).latest_data, 'no latest row');
      assertRainDay(byEui.get(LSN50_RAIN).latest_data, '2026-07-01', 'UTC', 'unassigned_default', 'LSN50 rain');
      assert.equal(handles.closed, handles.opened.length);
    } finally {
      db.close();
    }
  });
}
