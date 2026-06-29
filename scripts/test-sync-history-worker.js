#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const helperPaths = [
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper',
  '../conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper'
];

const row = {
  id: 123,
  deveui: 'A84041CAFECAFE01',
  recorded_at: '2026-06-28T10:00:00Z',
  swt_1: 1,
  swt_2: null,
  dendro_valid: 1
};

function assertSameHelperFile(relPath) {
  const bcm2712 = path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files', relPath);
  const bcm2709 = path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2709/files', relPath);
  assert.strictEqual(fs.readFileSync(bcm2712, 'utf8'), fs.readFileSync(bcm2709, 'utf8'), relPath);
}

assertSameHelperFile('usr/share/node-red/osi-history-sync-helper/index.js');
assertSameHelperFile('usr/share/node-red/osi-history-sync-helper/package.json');

const advertisedTableRows = {
  chameleon_readings: {
    id: 11,
    deveui: 'A84041CAFECAFE01',
    recorded_at: '2026-06-28T10:01:00Z',
    payload_version: 1,
    status_flags: 3,
    data_invalid: 0,
    comp_pending: 1,
    f_port: 2,
    f_cnt: 42,
    calibration_status: 'calibrated'
  },
  dendrometer_readings: {
    id: 12,
    deveui: 'A84041CAFECAFE02',
    recorded_at: '2026-06-28T10:02:00Z',
    position_um: 123.5,
    is_valid: 1,
    is_outlier: 0,
    dendro_saturated: 0
  },
  dendrometer_daily: {
    deveui: 'A84041CAFECAFE02',
    date: '2026-06-28',
    mds_um: 25.5,
    twd_um: 10.25,
    stress_level: 'moderate',
    computed_at: '2026-06-28T23:00:00Z'
  },
  zone_daily_environment: {
    zone_uuid: 'zone-uuid-1',
    date: '2026-06-28',
    rainfall_mm: 1.25,
    flow_liters: 15.5,
    rain_source: 'sensor',
    computed_at: '2026-06-28T23:01:00Z'
  },
  irrigation_events: {
    event_uuid: 'irrig-0016C001F11715E2-000000000001',
    created_at: '2026-06-28T23:02:00Z',
    action: 'OPEN',
    reason: 'threshold',
    aggregate_kpa: 35.5,
    threshold_kpa: 30,
    duration_minutes: 20,
    valve_deveui: 'A84041VALVE0001',
    payload_json: '{"b":2,"a":1}'
  }
};

function runHelperAssertions(helper, label) {
  assert.strictEqual(helper.historyKey('device_data', '0016C001F11715E2', row), 'DEVICE_DATA|0016C001F11715E2|123', label);
  assert.strictEqual(helper.nextRawQuery('device_data'), 'SELECT * FROM device_data WHERE id > ? ORDER BY id ASC LIMIT ?', label);
  assert.deepStrictEqual(helper.buildCanonicalColumns('device_data', row), [
    ['id', 'INTEGER', '123'],
    ['deveui', 'TEXT', 'A84041CAFECAFE01'],
    ['recorded_at', 'TIMESTAMP', '2026-06-28T10:00:00.000Z'],
    ['swt_1', 'REAL', '3ff0000000000000'],
    ['swt_2', 'REAL', null],
    ['dendro_valid', 'BOOLEAN', true]
  ], label);
  assert.deepStrictEqual(helper.buildCanonicalColumns('device_data', {
    id: '9007199254740993',
    deveui: 'A84041CAFECAFE01',
    recorded_at: '2026-06-28T10:00:00Z',
    swt_1: null,
    swt_2: null,
    dendro_valid: 1
  })[0], ['id', 'INTEGER', '9007199254740993'], label);
  assert.throws(() => helper.buildCanonicalColumns('device_data', {
    id: '12x',
    deveui: 'A84041CAFECAFE01',
    recorded_at: '2026-06-28T10:00:00Z'
  }), /invalid INTEGER/, label);
  assert.throws(() => helper.buildCanonicalColumns('device_data', {
    id: 125,
    deveui: 'A84041CAFECAFE01',
    recorded_at: '2026-06-28T10:00:00Z',
    dendro_valid: 'maybe'
  }), /invalid BOOLEAN/, label);
  assert.strictEqual(
    helper.hashHistoryRow('device_data', 'DEVICE_DATA|0016C001F11715E2|123', row),
    '39eb29940bfb23a1d5b84a573daf646e48c5e4e768d2068385fa5083fd62a371',
    label
  );

  assert.deepStrictEqual(helper.cursorPatchFromResponse({
    ackedThroughId: 123,
    results: [{ historyKey: 'DEVICE_DATA|0016C001F11715E2|123', status: 'APPLIED' }]
  }), { last_acked_id: '123', last_error: null, retry_count: 0 }, label);

  assert.deepStrictEqual(helper.cursorPatchFromResponse({
    results: [{ historyKey: 'DEVICE_DATA|0016C001F11715E2|124', status: 'REJECTED_PERMANENT', reason: 'unsupported_hash_version' }]
  }), { last_error: 'permanent: unsupported_hash_version', next_attempt_at: '9999-12-31T00:00:00.000Z' }, label);

  assert.deepStrictEqual(helper.cursorPatchFromResponse({
    ackedThroughId: 123,
    results: [
      { historyKey: 'DEVICE_DATA|0016C001F11715E2|123', status: 'APPLIED' },
      { historyKey: 'DEVICE_DATA|0016C001F11715E2|124', status: 'REJECTED_PERMANENT', reason: 'hash_mismatch' }
    ]
  }), {
    last_acked_id: '123',
    last_error: 'permanent: hash_mismatch',
    next_attempt_at: '9999-12-31T00:00:00.000Z'
  }, label);

  assert.strictEqual(helper.isBackfillComplete({ snapshot_high_id: 123, last_acked_id: 123 }), true, label);
  assert.strictEqual(helper.isBackfillComplete({ snapshot_high_id: 124, last_acked_id: 123 }), false, label);

  assert.strictEqual(helper.shouldApplyDurableAck({ phase: 'shadow' }, { history_mirror_write_v1_confirmed: true }), false, label);
  assert.strictEqual(helper.shouldApplyDurableAck({ phase: 'backfill' }, { history_mirror_write_v1_confirmed: false }), false, label);
  assert.strictEqual(helper.shouldApplyDurableAck({ phase: 'backfill' }, { history_mirror_write_v1_confirmed: true }), true, label);

  const segment = helper.segmentKey('device_data', { deveui: 'A84041CAFECAFE01', recorded_at: '2026-06-28T10:00:00.000Z' });
  assert.strictEqual(segment, 'A84041CAFECAFE01|2026-06-28', label);

  for (const [tableName, sourceRow] of Object.entries(advertisedTableRows)) {
    assert.doesNotThrow(() => helper.buildCanonicalColumns(tableName, sourceRow), `${label} ${tableName}`);
    assert.strictEqual(typeof helper.hashHistoryRow(tableName, helper.historyKey(tableName, '0016C001F11715E2', sourceRow), sourceRow), 'string', `${label} ${tableName}`);
  }

  assert.deepStrictEqual(helper.buildCanonicalColumns('irrigation_events', advertisedTableRows.irrigation_events).at(-1), [
    'payload_json',
    'JSON',
    '{"a":1,"b":2}'
  ], label);
}

for (const helperPath of helperPaths) {
  runHelperAssertions(require(helperPath), helperPath);
}

console.log('OK sync history worker helper');
