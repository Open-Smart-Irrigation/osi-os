'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { readEvidence } = require('./observations');
const { evaluateCondition } = require('./evaluate');
const da = require('../osi-dendro-analytics');
const tensiomarkLayout = require('../osi-history-helper/__fixtures__/tensiomark-layout.json');

const REPO = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO, 'database/seed-blank.sql'), 'utf8');

function realDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SEED);
  return {
    raw,
    all(sql, params) { return Promise.resolve(raw.prepare(sql).all(...(params || []))); },
  };
}

function reader(rows) {
  const calls = [];
  function matching(sql) {
    if (sql.includes('FROM devices')) return rows.devices || [];
    if (sql.includes('FROM device_data')) {
      const watermarkIds = new Set((rows.watermark || []).map((row) => row.device_data_id));
      return (rows.samples || []).map((row) => ({ ...row, value: row.value ?? row.vwc_1 ?? row.swt_1,
        watermark_ineligible: watermarkIds.has(row.id) ? 1 : 0 }));
    }
    if (sql.includes('FROM watermark_readings')) return rows.watermark || [];
    if (sql.includes('FROM chameleon_readings')) return rows.chameleon || [];
    if (sql.includes('FROM irrigation_zones')) return rows.zones || [];
    if (sql.includes('FROM zone_daily_recommendations')) return rows.recommendations || [];
    return rows[sql] || [];
  }
  return {
    calls,
    async all(sql, params) { calls.push({ sql, params }); return matching(sql); },
    async get(sql, params) { calls.push({ sql, params }); return matching(sql)[0]; },
  };
}

test('readEvidence selects only commissioned SDI12 VWC channels and binds values', async () => {
  const source = { device_eui: '0016C001F1000002', channel: 'vwc_1' };
  const db = reader({
    devices: [{ deveui: source.device_eui, type_id: 'DRAGINO_SDI12', irrigation_zone_id: 7,
      sdi12_probe_profile: 'GENERIC_VWC', sdi12_probe_status: 'manual', sdi12_value_count: 1,
      sdi12_channel_layout_json: null }],
    samples: [{ id: 1, deveui: source.device_eui, recorded_at: '2026-10-16 05:55:00', vwc_1: 20 }],
  });
  const result = await readEvidence({ db, policy: { zone_id: 7, condition: { kind: 'VWC', threshold_percent: 22, sources: [source] } }, dueAt: '2026-10-16T06:00:00Z' });
  assert.equal(result.sources[0].eligible, true);
  assert.equal(result.sources[0].samples[0].value, 20);
  assert.ok(db.calls.some((call) => call.params && call.params.includes(source.device_eui)));
  assert.ok(db.calls.every((call) => !(call.params || []).includes('vwc_1')));
});

test('SWT eligibility admits only declared KIWI channels', async () => {
  for (const channel of ['swt_1', 'swt_2']) {
    const source = { device_eui: '0016C001F1000101', channel };
    const result = await readEvidence({
      db: reader({
        devices: [{ deveui: source.device_eui, type_id: 'KIWI_SENSOR', irrigation_zone_id: 7 }],
        samples: [{ id: 1, deveui: source.device_eui, recorded_at: '2026-10-16 05:55:00', value: 40 }],
      }),
      policy: { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [source] } },
      dueAt: '2026-10-16T06:00:00Z',
    });
    assert.equal(result.sources[0].eligible, true, channel);
  }
  const undeclared = await readEvidence({
    db: reader({ devices: [{ deveui: '0016C001F1000101', type_id: 'KIWI_SENSOR', irrigation_zone_id: 7 }] }),
    policy: { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [{ device_eui: '0016C001F1000101', channel: 'swt_3' }] } },
    dueAt: '2026-10-16T06:00:00Z',
  });
  assert.equal(undeclared.sources[0].eligible, false);
  assert.equal(undeclared.sources[0].reason, 'channel_not_declared');
});

test('validated Tensiomark layouts gate SWT channels and allow awaiting-first-reading choices', async () => {
  const oneSensor = { ...tensiomarkLayout, sensors: [tensiomarkLayout.sensors[0]] };
  const device = (layout) => ({ deveui: '0016C001F1000102', type_id: 'DRAGINO_SDI12', irrigation_zone_id: 7,
    sdi12_probe_profile: 'TENSIOMARK', sdi12_channel_layout_json: layout == null ? layout : JSON.stringify(layout) });
  const available = await readEvidence({
    db: reader({ devices: [device(tensiomarkLayout)] }),
    policy: { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [
      { device_eui: '0016C001F1000102', channel: 'swt_1' }, { device_eui: '0016C001F1000102', channel: 'swt_2' },
    ] } },
    dueAt: '2026-10-16T06:00:00Z',
  });
  assert.deepEqual(available.sources.map((source) => [source.eligible, source.samples.length]), [[true, 0], [true, 0]]);
  const one = await readEvidence({
    db: reader({ devices: [device(oneSensor)] }),
    policy: { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [{ device_eui: '0016C001F1000102', channel: 'swt_2' }] } },
    dueAt: '2026-10-16T06:00:00Z',
  });
  assert.equal(one.sources[0].eligible, false);
  assert.equal(one.sources[0].reason, 'channel_not_declared');
  for (const layout of [null, '{bad json', { ...tensiomarkLayout, source_unit: 'kPa' }]) {
    const unavailable = await readEvidence({
      db: reader({ devices: [device(layout)] }),
      policy: { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [{ device_eui: '0016C001F1000102', channel: 'swt_1' }] } },
      dueAt: '2026-10-16T06:00:00Z',
    });
    assert.equal(unavailable.sources[0].eligible, false);
    assert.equal(unavailable.sources[0].reason, 'channel_not_commissioned');
  }
  const profileOnly = await readEvidence({
    db: reader({ devices: [device(null)] }),
    policy: { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [{ device_eui: '0016C001F1000102', channel: 'swt_1' }] } },
    dueAt: '2026-10-16T06:00:00Z',
  });
  assert.equal(profileOnly.sources[0].eligible, false);
});

test('canonical SWT values use the upstream 0..1000000 domain while the threshold stays bounded', () => {
  const condition = { kind: 'SWT', threshold_kpa: 300, sources: [{ device_eui: '0016C001F1000102', channel: 'swt_1' }] };
  for (const value of [0, 300, 500, 1000000]) {
    const evidence = { sources: [{ device_eui: '0016C001F1000102', channel: 'swt_1', eligible: true,
      samples: [{ id: 1, at: '2026-10-16T05:55:00.000Z', value }] }] };
    const result = evaluateCondition(condition, evidence, '2026-10-16T06:00:00Z', 60);
    assert.equal(result.status, value >= 300 ? 'MET' : 'NOT_MET', String(value));
  }
  const tooLarge = evaluateCondition(condition, { sources: [{ device_eui: '0016C001F1000102', channel: 'swt_1', eligible: true,
    samples: [{ id: 1, at: '2026-10-16T05:55:00.000Z', value: 1000000.1 }] }] }, '2026-10-16T06:00:00Z', 60);
  assert.equal(tooLarge.status, 'UNKNOWN');
  assert.equal(tooLarge.reason, 'missing_evidence');
  const rejected = evaluateCondition(condition, { sources: [{ device_eui: '0016C001F1000102', channel: 'swt_1', eligible: true, samples: [] }] }, '2026-10-16T06:00:00Z', 60);
  assert.equal(rejected.status, 'UNKNOWN');
  assert.equal(rejected.reason, 'missing_evidence');
});

test('readEvidence excludes an ineligible WATERMARK channel and leaves it UNKNOWN', async () => {
  const source = { device_eui: '0016C001F1000003', channel: 'swt_1' };
  const db = reader({
    devices: [{ deveui: source.device_eui, type_id: 'DRAGINO_LSN50', irrigation_zone_id: 7,
      chameleon_enabled: 1 }],
    samples: [{ id: 1, deveui: source.device_eui, recorded_at: '2026-10-16 05:55:00', swt_1: 40 }],
    watermark: [{ id: 2, device_data_id: 1 }],
    chameleon: [{ id: 1, recorded_at: '2026-10-16 05:55:00', calibration_status: 'calibrated' }],
  });
  const result = await readEvidence({ db, policy: { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [source] } }, dueAt: '2026-10-16T06:00:00Z' });
  assert.equal(result.sources[0].eligible, true);
  assert.equal(result.sources[0].samples.length, 0);
});

test('readEvidence uses the commissioned source resolver against the real seed schema', async () => {
  const db = realDb();
  db.raw.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-01-01T00:00:00Z')").run();
  db.raw.prepare("INSERT INTO irrigation_zones (id, user_id, name, zone_uuid) VALUES (7, 1, 'Zone 7', 'zone-7')").run();
  db.raw.prepare("INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, sdi12_probe_profile, sdi12_probe_status, sdi12_value_count, created_at, updated_at) VALUES ('0016C001F1000005', 'SDI', 'DRAGINO_SDI12', 1, 7, 'IMKO_PICO64', 'identified', 2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
  db.raw.prepare("INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, sdi12_probe_profile, sdi12_probe_status, sdi12_value_count, created_at, updated_at) VALUES ('0016C001F1000006', 'Uncommissioned', 'DRAGINO_SDI12', 1, 7, 'IMKO_PICO64', 'pending_identify', 2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
  db.raw.prepare("INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, sdi12_probe_profile, sdi12_probe_status, sdi12_value_count, created_at, updated_at) VALUES ('0016C001F1000007', 'Generic', 'DRAGINO_SDI12', 1, 7, 'GENERIC_VWC', 'manual', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
  db.raw.prepare("INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, sdi12_probe_profile, sdi12_probe_status, sdi12_value_count, created_at, updated_at) VALUES ('0016C001F1000008', 'Generic without count', 'DRAGINO_SDI12', 1, 7, 'GENERIC_VWC', 'manual', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
  db.raw.prepare("INSERT INTO device_data (deveui, recorded_at, vwc_1) VALUES ('0016C001F1000005', '2026-10-16 05:55:00', 0)").run();
  db.raw.prepare("INSERT INTO device_data (deveui, recorded_at, vwc_1) VALUES ('0016C001F1000006', '2026-10-16 05:55:00', 0)").run();
  db.raw.prepare("INSERT INTO device_data (deveui, recorded_at, vwc_1) VALUES ('0016C001F1000007', '2026-10-16 05:55:00', 0)").run();
  db.raw.prepare("INSERT INTO device_data (deveui, recorded_at, vwc_1) VALUES ('0016C001F1000008', '2026-10-16 05:55:00', 0)").run();
  const policy = { zone_uuid: 'zone-7', condition: { kind: 'VWC', threshold_percent: 22, sources: [
    { device_eui: '0016C001F1000005', channel: 'vwc_1' },
    { device_eui: '0016C001F1000006', channel: 'vwc_1' },
    { device_eui: '0016C001F1000007', channel: 'vwc_1' },
    { device_eui: '0016C001F1000008', channel: 'vwc_1' },
  ] } };
  const result = await readEvidence({ db, policy, dueAt: '2026-10-16T06:00:00Z' });
  assert.equal(result.sources[0].eligible, false);
  assert.equal(result.sources[0].reason, 'channel_not_commissioned');
  assert.equal(result.sources[1].eligible, false);
  assert.equal(result.sources[1].reason, 'channel_not_commissioned');
  assert.equal(result.sources[2].eligible, true);
  assert.equal(result.sources[2].samples[0].value, 0);
  assert.equal(result.sources[3].eligible, false);
  assert.equal(result.sources[3].reason, 'channel_not_commissioned');
  db.raw.close();
});

test('readEvidence does not replay a cached DENDRO row without captured raw evidence', async () => {
  const db = reader({ recommendations: [{ id: 2, computed_at: '2026-10-16T05:00:00Z',
    recommendation_json: JSON.stringify({ zone_stress: 'severe', action: 'emergency_irrigate' }) }] });
  const result = await readEvidence({ db, policy: { zone_id: 7, condition: { kind: 'DENDRO', minimum_stress: 'moderate', response_mode: 'fixed' } }, dueAt: '2026-10-16T06:00:00Z' });
  assert.equal(result.analysis, null);
  assert.equal(result.reason, 'dendro_raw_evidence_missing');
});

test('readEvidence keeps the raw DENDRO action from a cached row before legacy downgrade', async () => {
  const db = reader({ recommendations: [{ id: 3, computed_at: '2026-10-16T05:00:00Z',
    recommendation_json: JSON.stringify({ action: 'maintain', raw_decision: { version: 1, action: 'increase_10', computed_at: '2026-10-16T05:00:00Z' },
      raw_evidence: { version: 1, analysis: { stress: 'moderate', usable_tree_count: 2, action: 'increase_10', computed_at: '2026-10-16T05:00:00Z' } } }) }] });
  const result = await readEvidence({ db, policy: { zone_id: 7, condition: { kind: 'DENDRO', minimum_stress: 'mild', response_mode: 'fixed' } }, dueAt: '2026-10-16T06:00:00Z' });
  assert.equal(result.analysis.action, 'increase_10');
  assert.equal(result.analysis.stress, 'moderate');
  assert.equal(da.applyDendroSchedulePolicy(
    { action: result.analysis.action, reasoning: 'Moderate stress' }, ['moderate'],
    { enabled: 1, trigger_metric: 'DENDRO', threshold_kpa: 3 },
  ).action, 'maintain');
});

test('real SQLite evidence applies row-level WATERMARK exclusion and keeps later Chameleon history', async () => {
  const db = realDb();
  db.raw.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-01-01T00:00:00Z')").run();
  db.raw.prepare("INSERT INTO irrigation_zones (id, user_id, name, zone_uuid) VALUES (7, 1, 'Zone 7', 'zone-7')").run();
  const eui = '0016C001F1000010';
  db.raw.prepare("INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, chameleon_enabled, created_at, updated_at) VALUES (?, 'SWT', 'DRAGINO_LSN50', 1, 7, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run(eui);
  db.raw.prepare("INSERT INTO chameleon_readings (deveui, recorded_at, calibration_status) VALUES (?, '2026-10-16 05:55:00', 'calibrated')").run(eui);
  const older = db.raw.prepare("INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, '2026-10-16 05:55:00', 40)").run(eui);
  const corrected = db.raw.prepare("INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, '2026-10-16 05:55:00', 10)").run(eui);
  db.raw.prepare("INSERT INTO watermark_readings (deveui, recorded_at, device_data_id, payload_hex, frame_status, conversion_version) VALUES (?, '2026-10-16 05:55:00', ?, '00', 'accepted', 'test-v1')").run(eui, corrected.lastInsertRowid);
  const policy = { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [{ device_eui: eui, channel: 'swt_1' }] } };
  const blocked = await readEvidence({ db, policy, dueAt: '2026-10-16T06:00:00Z' });
  assert.equal(blocked.sources[0].eligible, true);
  assert.equal(blocked.sources[0].samples.length, 0);
  db.raw.prepare("INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, '2026-10-16 05:56:00', 40)").run(eui);
  const later = await readEvidence({ db, policy, dueAt: '2026-10-16T06:00:00Z' });
  assert.deepEqual(later.sources[0].samples.map((sample) => sample.value), [40]);
  assert.notEqual(older.lastInsertRowid, corrected.lastInsertRowid);
  db.raw.close();
});

test('real SQLite Chameleon eligibility selects parsed latest time and fails closed for calibration and each fault', async () => {
  const db = realDb();
  db.raw.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-01-01T00:00:00Z')").run();
  db.raw.prepare("INSERT INTO irrigation_zones (id, user_id, name, zone_uuid) VALUES (7, 1, 'Zone 7', 'zone-7')").run();
  const insertDevice = db.raw.prepare("INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, chameleon_enabled, created_at, updated_at) VALUES (?, ?, 'DRAGINO_LSN50', 1, 7, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
  const insertData = db.raw.prepare("INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES (?, '2026-10-16 05:55:00', 40)");
  const insertReading = db.raw.prepare("INSERT INTO chameleon_readings (deveui, recorded_at, calibration_status, i2c_missing, timeout, temp_fault, id_fault, ch1_open, ch2_open, ch3_open, data_invalid, comp_pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const outOfOrder = '0016C001F1000020';
  insertDevice.run(outOfOrder, 'Out of order');
  insertData.run(outOfOrder);
  insertReading.run(outOfOrder, '2026-10-16 05:55:00', 'calibrated', 0, 0, 0, 0, 0, 0, 0, 0, 0);
  insertReading.run(outOfOrder, '2026-10-15 05:55:00', 'calibrated', 1, 0, 0, 0, 0, 0, 0, 0, 0);
  const good = await readEvidence({ db, policy: { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [{ device_eui: outOfOrder, channel: 'swt_1' }] } }, dueAt: '2026-10-16T06:00:00Z' });
  assert.equal(good.sources[0].eligible, true);
  const malformed = '0016C001F1000021';
  insertDevice.run(malformed, 'Malformed health');
  insertData.run(malformed);
  insertReading.run(malformed, '2026-10-16 05:55:00', 'calibrated', 0, 0, 0, 0, 0, 0, 0, 0, 0);
  insertReading.run(malformed, 'garbage', 'calibrated', 0, 0, 0, 0, 0, 0, 0, 0, 0);
  const malformedResult = await readEvidence({ db, policy: { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [{ device_eui: malformed, channel: 'swt_1' }] } }, dueAt: '2026-10-16T06:00:00Z' });
  assert.equal(malformedResult.sources[0].eligible, false);
  assert.equal(malformedResult.sources[0].reason, 'invalid_health_timestamp');

  const cases = [
    ['calibration', 'calibrated', {}],
    ['i2c_missing', 'calibrated', { i2c_missing: 1 }], ['timeout', 'calibrated', { timeout: 1 }],
    ['temp_fault', 'calibrated', { temp_fault: 1 }], ['id_fault', 'calibrated', { id_fault: 1 }],
    ['ch1_open', 'calibrated', { ch1_open: 1 }], ['ch2_open', 'calibrated', { ch2_open: 1 }],
    ['ch3_open', 'calibrated', { ch3_open: 1 }], ['data_invalid', 'calibrated', { data_invalid: 1 }],
    ['comp_pending', 'calibrated', { comp_pending: 1 }],
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const [name, calibration, flags] = cases[i];
    const eui = `0016C001F10000${String(30 + i).padStart(2, '0')}`;
    insertDevice.run(eui, name);
    insertData.run(eui);
    insertReading.run(eui, '2026-10-16 05:55:00', name === 'calibration' ? 'pending' : calibration,
      flags.i2c_missing || 0, flags.timeout || 0, flags.temp_fault || 0, flags.id_fault || 0,
      flags.ch1_open || 0, flags.ch2_open || 0, flags.ch3_open || 0, flags.data_invalid || 0, flags.comp_pending || 0);
    const result = await readEvidence({ db, policy: { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [{ device_eui: eui, channel: 'swt_1' }] } }, dueAt: '2026-10-16T06:00:00Z' });
    const expectedEligible = name !== 'calibration' && name !== 'ch1_open'
      && !['i2c_missing', 'timeout', 'temp_fault', 'id_fault', 'data_invalid', 'comp_pending'].includes(name);
    assert.equal(result.sources[0].eligible, expectedEligible, name);
    if (!expectedEligible) assert.equal(result.sources[0].reason, name === 'calibration' ? 'calibration_unavailable' : 'sensor_fault', name);
  }
  db.raw.close();
});

test('real SQLite Chameleon open faults apply only to the selected SWT channel', async () => {
  const db = realDb();
  db.raw.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-01-01T00:00:00Z')").run();
  db.raw.prepare("INSERT INTO irrigation_zones (id, user_id, name, zone_uuid) VALUES (7, 1, 'Zone 7', 'zone-7')").run();
  const eui = '0016C001F1000040';
  db.raw.prepare("INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, chameleon_enabled, created_at, updated_at) VALUES (?, 'Channel-specific', 'DRAGINO_LSN50', 1, 7, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run(eui);
  db.raw.prepare("INSERT INTO chameleon_readings (deveui, recorded_at, calibration_status, ch2_open) VALUES (?, '2026-10-16 05:55:00', 'calibrated', 1)").run(eui);
  db.raw.prepare("INSERT INTO device_data (deveui, recorded_at, swt_1, swt_2) VALUES (?, '2026-10-16 05:55:00', 40, NULL)").run(eui);
  const onlySwt1 = { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [{ device_eui: eui, channel: 'swt_1' }] } };
  const selectedOne = await readEvidence({ db, policy: onlySwt1, dueAt: '2026-10-16T06:00:00Z' });
  assert.equal(selectedOne.sources[0].eligible, true);
  assert.equal(selectedOne.sources[0].samples.length, 1);
  const both = { zone_id: 7, condition: { kind: 'SWT', threshold_kpa: 30, sources: [
    { device_eui: eui, channel: 'swt_1' }, { device_eui: eui, channel: 'swt_2' },
  ] } };
  const selectedBoth = await readEvidence({ db, policy: both, dueAt: '2026-10-16T06:00:00Z' });
  assert.equal(selectedBoth.sources[1].eligible, false);
  assert.equal(selectedBoth.sources[1].reason, 'sensor_fault');
  assert.equal(selectedBoth.sources[1].samples.length, 0);
  assert.equal(evaluateCondition(both.condition, selectedBoth, '2026-10-16T06:00:00Z', 60).status, 'UNKNOWN');
  db.raw.close();
});
