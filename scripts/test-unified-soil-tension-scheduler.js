'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const flows = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const buildQuery = new Function('msg', flows.find(n => n.id === 'd0b2b1c1a937e16d').func);

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE devices(deveui TEXT, type_id TEXT, irrigation_zone_id INTEGER, chameleon_enabled INTEGER);
    CREATE TABLE device_data(id INTEGER PRIMARY KEY, deveui TEXT, recorded_at TEXT, swt_1 REAL, swt_2 REAL, swt_3 REAL, swt_wm1 REAL, swt_wm2 REAL);
    CREATE TABLE watermark_readings(device_data_id INTEGER, deveui TEXT, frame_status TEXT);`);
  const device = db.prepare('INSERT INTO devices VALUES(?,?,?,?)');
  const reading = db.prepare('INSERT INTO device_data VALUES(?,?,?,?,?,?,NULL,NULL)');
  const now = new Date().toISOString();
  for (const [i, type, zone, chameleon] of [
    [1, 'KIWI_SENSOR', 1, 0], [2, 'DRAGINO_SDI12', 1, 0], [3, 'DRAGINO_LSN50', 1, 0],
    [4, 'DRAGINO_LSN50', 1, 1], [5, 'SENSECAP_S2120', 1, 0], [6, 'KIWI_SENSOR', 2, 0], [7, 'DRAGINO_LSN50', 1, 0],
  ]) {
    device.run(String(i), type, zone, chameleon);
    reading.run(i, String(i), now, i <= 4 ? 30 : 200, i <= 4 ? 50 : 200, null);
  }
  db.exec("INSERT INTO watermark_readings VALUES(3, '3', 'accepted')");
  return db;
}

// KIWI, Tensiomark (DRAGINO_SDI12) and Chameleon LSN50 estimates count equally.
// WATERMARK phase 1 interlock: an LSN50 observation linked from
// watermark_readings never drives irrigation, whatever its frame status, until
// the owner's phase 3 explicit enable (spec 2026-09-25 section 8).
for (const [metric, mean] of [['SWT_1', 30], ['SWT_2', 50], ['SWT_AVG', 40]]) {
  test(`${metric} averages KIWI, Tensiomark and Chameleon estimates and excludes WATERMARK`, () => {
    const db = fixture();
    try {
      const { topic } = buildQuery({ payload: { zone_id: 1, trigger_metric: metric } });
      const row = db.prepare(topic).get();
      assert.equal(row.n_points, 3);
      assert.equal(row.mean_kpa, mean);
    } finally { db.close(); }
  });
}

test('a WATERMARK observation stays excluded when its frame was rejected or its device has Chameleon enabled', () => {
  const db = fixture();
  try {
    db.exec("UPDATE watermark_readings SET frame_status='frame_rejected'; UPDATE devices SET chameleon_enabled=1 WHERE deveui='3';");
    db.exec("INSERT INTO device_data VALUES(8, '4', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 90, 90, NULL, NULL, NULL); INSERT INTO watermark_readings VALUES(8, '4', 'accepted');");
    const { topic } = buildQuery({ payload: { zone_id: 1, trigger_metric: 'SWT_1' } });
    const row = db.prepare(topic).get();
    assert.equal(row.n_points, 3);
    assert.equal(row.mean_kpa, 30);
  } finally { db.close(); }
});

test('missing channels and old readings are excluded; a measured Tensiomark zero remains usable', () => {
  const db = fixture();
  try {
    db.exec("UPDATE device_data SET swt_1=NULL WHERE id=1; UPDATE device_data SET swt_1=0 WHERE id=2; INSERT INTO device_data VALUES(9, '4', '2000-01-01T00:00:00.000Z', 999, 999, NULL, NULL, NULL);");
    const { topic } = buildQuery({ payload: { zone_id: 1, trigger_metric: 'SWT_1' } });
    const row = db.prepare(topic).get();
    assert.equal(row.n_points, 2);
    assert.equal(row.mean_kpa, 15);
  } finally { db.close(); }
});
