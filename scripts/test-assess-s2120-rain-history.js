#!/usr/bin/env node
'use strict';

// scripts/assess-s2120-rain-history.js on a synthetic database built from
// database/seed-blank.sql: a pre-fix day with retained uplinks (mismatch),
// a pre-fix day without (unverifiable), a post-fix day (match), a legacy
// device whose uplinks carry no 4213, and the read-only guarantees.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { assess, formatText } = require('./assess-s2120-rain-history');

const repoRoot = path.resolve(__dirname, '..');
const V2_EUI = 'A840410000000001';
const LEGACY_EUI = 'A840410000000002';

function hex(value, width) {
  return Math.round(value).toString(16).toUpperCase().padStart(width, '0');
}

// Frames from the S2120 user guide 10.2: 4B/02 = wind direction, rain
// intensity (x1000), pressure; 4C = peak gust, cumulative rain (x1000).
function v2Payload(intensity, cumulative) {
  return Buffer.from('4B0156' + hex(intensity * 1000, 8) + '2703' + '4C000B' + hex(cumulative * 1000, 8), 'hex').toString('base64');
}
function legacyPayload(intensity) {
  return Buffer.from('020156' + hex(intensity * 1000, 8) + '2703', 'hex').toString('base64');
}

function buildFixture(dir) {
  const dbPath = path.join(dir, 'farming-copy.db');
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(path.join(repoRoot, 'database/seed-blank.sql'), 'utf8'));
  const device = db.prepare("INSERT INTO devices (deveui, name, type_id, created_at, updated_at) VALUES (?, ?, 'SENSECAP_S2120', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')");
  device.run(V2_EUI, 'Station one');
  device.run(LEGACY_EUI, 'Station two');
  const row = db.prepare(
    'INSERT INTO device_data (deveui, recorded_at, rain_gauge_cumulative_mm, rain_mm_per_hour, rain_mm_delta, rain_delta_status) VALUES (?, ?, ?, ?, ?, ?)'
  );
  // Day 1, pre-fix: old ingest stored 4113 as "cumulative" and differenced it.
  row.run(V2_EUI, '2026-10-01T10:00:00.000Z', 0.254, null, null, 'first_sample');
  row.run(V2_EUI, '2026-10-01T10:10:00.000Z', 0.254, 0, 0, 'ok');
  row.run(V2_EUI, '2026-10-01T10:20:00.000Z', 1.524, 7.62, 1.3, 'ok');
  // Day 2, pre-fix, no retained uplinks; intervals of 600 s and one of 1200 s.
  row.run(V2_EUI, '2026-10-02T10:00:00.000Z', 3.048, null, null, 'counter_reset');
  row.run(V2_EUI, '2026-10-02T10:10:00.000Z', 1.524, null, null, 'counter_reset');
  row.run(V2_EUI, '2026-10-02T10:30:00.000Z', 1.524, 0, 0, 'ok');
  // Day 3, post-fix: 4213 from the counter baseline on.
  row.run(V2_EUI, '2026-10-03T10:00:00.000Z', 5, 0.254, null, 'cumulative_baseline');
  row.run(V2_EUI, '2026-10-03T10:10:00.000Z', 5.254, 1.524, 0.254, 'ok');
  row.run(V2_EUI, '2026-10-03T10:20:00.000Z', 5.508, 1.524, 0.254, 'ok');
  // Legacy device, pre-fix.
  row.run(LEGACY_EUI, '2026-10-01T10:00:00.000Z', 0, null, null, 'first_sample');
  row.run(LEGACY_EUI, '2026-10-01T10:10:00.000Z', 1.524, 9.144, 1.5, 'ok');
  db.close();

  const uplinksPath = path.join(dir, 'uplinks.jsonl');
  const event = (devEui, time, data) => JSON.stringify({ time, deviceInfo: { devEui }, data });
  fs.writeFileSync(uplinksPath, [
    event(V2_EUI, '2026-10-01T10:00:00.000Z', v2Payload(0.254, 1.778)),
    event(V2_EUI, '2026-10-01T10:10:00.000Z', v2Payload(0.254, 2.032)),
    event(V2_EUI, '2026-10-01T10:20:00.000Z', v2Payload(1.524, 2.286)),
    event(LEGACY_EUI, '2026-10-01T10:00:00.000Z', legacyPayload(0)),
    event(LEGACY_EUI, '2026-10-01T10:10:00.000Z', legacyPayload(1.524)),
    event('A840410000000099', '2026-10-01T10:10:00.000Z', v2Payload(0, 1)),
    'not json',
  ].join('\n') + '\n');
  return { dbPath, uplinksPath };
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('assessment compares stored increments with 4213 and marks the rest unverifiable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-s2120-assess-'));
  try {
    const { dbPath, uplinksPath } = buildFixture(dir);
    const before = digest(dbPath);
    const report = assess({ dbPath, uplinksPath, timeZone: 'UTC' });
    assert.equal(digest(dbPath), before, 'the database copy is not modified');
    assert.equal(report.uplinkLinesSkipped, 2, 'unknown devices and broken lines are skipped');

    const v2 = report.devices.find((device) => device.devEui === V2_EUI);
    const day = (d) => v2.days.find((entry) => entry.day === d);
    assert.deepEqual(
      [day('2026-10-01').era, day('2026-10-01').storedIncrementMm, day('2026-10-01').reference4213Mm, day('2026-10-01').verdict, day('2026-10-01').reason],
      ['pre_fix', 1.3, 0.508, 'mismatch', 'retained_payloads'],
    );
    assert.equal(day('2026-10-01').differenceMm, -0.792);
    assert.deepEqual(
      [day('2026-10-02').verdict, day('2026-10-02').reason, day('2026-10-02').reference4213Mm],
      ['unverifiable', 'no_retained_payloads', null],
    );
    assert.equal(day('2026-10-02').intensityEstimateMm, 0.254, 'only the 600 s interval is estimated from 1.524 mm/h');
    assert.equal(day('2026-10-02').intensityEstimateIntervals, '1/3', 'the 1200 s interval and the cross-day interval stay unestimated');
    assert.deepEqual(
      [day('2026-10-03').era, day('2026-10-03').storedIncrementMm, day('2026-10-03').reference4213Mm, day('2026-10-03').verdict, day('2026-10-03').reason],
      ['post_fix', 0.508, 0.508, 'match', 'contract_rows'],
    );
    assert.deepEqual(v2.summary, { days: 3, match: 1, mismatch: 1, unverifiable: 1 });
    assert.equal(v2.unattributedIncrementMm, 2.714, 'the 4213 rise across the unverifiable day is reported, not placed on a day');
    assert.equal(v2.hasCounterBaseline, true);

    const legacy = report.devices.find((device) => device.devEui === LEGACY_EUI);
    assert.equal(legacy.days[0].verdict, 'unverifiable');
    assert.equal(legacy.days[0].reason, 'no_4213_in_payloads');
    assert.equal(legacy.days[0].intensityEstimateMm, 0.254);
    assert.equal(legacy.retainedPayloadsWithout4213, 2);

    const text = formatText(report);
    assert.match(text, /2026-10-01\tpre_fix\t3\t1\.3\t0\.508\t-0\.792\tmismatch\tretained_payloads/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without retained uplinks every pre-fix day is unverifiable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-s2120-assess-'));
  try {
    const { dbPath } = buildFixture(dir);
    const report = assess({ dbPath });
    const v2 = report.devices.find((device) => device.devEui === V2_EUI);
    assert.deepEqual(v2.days.map((entry) => entry.verdict), ['unverifiable', 'unverifiable', 'match']);
    assert.equal(v2.days[0].reason, 'no_retained_payloads');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the live gateway database path is refused', () => {
  assert.throws(() => assess({ dbPath: '/data/db/farming.db' }), /refusing the live gateway database/);
});
