#!/usr/bin/env node
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROFILE = 'full_raspberrypi_bcm27xx_bcm2712';
const CONF_ROOT = path.resolve(__dirname, '..', 'conf', PROFILE, 'files', 'usr', 'share');
const NR_ROOT = path.join(CONF_ROOT, 'node-red');
const SEED_SQL = path.resolve(__dirname, '..', 'database', 'seed-blank.sql');

const TEST_DEVEUI = 'A84041CAFECAFE01';

function loadEdgeManifest() {
  return JSON.parse(fs.readFileSync(path.join(NR_ROOT, 'edge-channels.json'), 'utf8'));
}

function loadCodecViaVm(codecPath) {
  const source = fs.readFileSync(codecPath, 'utf8');
  const sandbox = { Buffer, console };
  const script = new vm.Script(source, { filename: codecPath });
  script.runInNewContext(sandbox, { timeout: 1000 });
  return sandbox;
}

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(SEED_SQL, 'utf8'));
  db.exec("INSERT INTO users(username, password_hash, created_at) VALUES('test','hash',datetime('now'))");
  const userId = db.prepare("SELECT id FROM users WHERE username = 'test'").get().id;
  db.prepare(
    "INSERT INTO devices(deveui, type_id, name, user_id, created_at, updated_at) VALUES(?, 'MILESIGHT_UC512', 'test-uc512', ?, datetime('now'), datetime('now'))"
  ).run(TEST_DEVEUI, userId);
  return db;
}

describe('UC512 round-trip: codec → normalizer → writer → DB', () => {
  const vectors = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, 'fixtures', 'device-integration', 'uc512', 'golden-vectors.json'), 'utf8'
  ));
  const codec = loadCodecViaVm(path.join(NR_ROOT, 'codecs', 'milesight_uc512_decoder.js'));
  const normalizer = require(path.join(NR_ROOT, 'osi-uc512-normalize'));
  const writer = require(path.join(NR_ROOT, 'osi-device-writer'));
  const manifest = loadEdgeManifest();

  for (const vector of vectors) {
    it(`round-trip: ${vector.name}`, () => {
      const decoded = codec.decodeUplink({
        fPort: vector.fPort,
        bytes: vector.bytes,
      });
      assert.ok(decoded && typeof decoded === 'object', 'codec must return an object');
      assert.ok(decoded.data && typeof decoded.data === 'object', 'codec must return data');

      const normalizeResult = normalizer.normalize(decoded.data, { recordedAt: '2026-07-12T10:00:00Z' });
      assert.ok(normalizeResult.channels && typeof normalizeResult.channels === 'object');

      const db = createTestDb();
      try {
        writer.resetColumnCache();
        const result = writer.writeDeviceData(db, manifest, normalizeResult, { deveui: TEST_DEVEUI }, {});

        assert.ok(Array.isArray(result.columns), 'writer must return columns array');
        assert.ok(result.columns.length > 0, 'at least one column must be written');

        const row = db.prepare('SELECT * FROM device_data WHERE deveui = ? ORDER BY rowid DESC LIMIT 1').get(TEST_DEVEUI);
        assert.ok(row, 'device_data row must exist');
        assert.equal(row.deveui, TEST_DEVEUI);

        for (const col of result.columns) {
          const channelEntry = manifest.find(e => e.edgeField === col);
          if (channelEntry) {
            const key = channelEntry.key;
            const normVal = normalizeResult.channels[key];
            if (normVal != null) {
              assert.ok(row[col] != null, `DB column ${col} must not be null for non-null normalize value`);
            }
          }
        }

        for (const dl of result.deadLettered) {
          assert.ok(dl.reason, 'dead-lettered entry must have a reason');
        }
      } finally {
        db.close();
      }
    });
  }
});

describe('LSN50 round-trip: normalizer → writer → DB (default mode)', () => {
  const normalizer = require(path.join(NR_ROOT, 'osi-lsn50-normalize'));
  const writer = require(path.join(NR_ROOT, 'osi-device-writer'));
  const manifest = loadEdgeManifest();

  it('default mode soil/dendro uplink', () => {
    const decoded = {
      devEui: TEST_DEVEUI,
      detectedMode: 1,
      timestamp: '2026-07-12T10:00:00Z',
      tempC1: 23.5,
      batV: 3.62,
      adcV: 1.23,
      adcCh1V: 0.45,
      swt1Kpa: 15.2,
      swt2Kpa: 18.7,
      swt3Kpa: null,
      dendroRatio: 0.85,
      dendroModeUsed: 'ratio_mod3',
      positionRawMm: 12.345,
      positionMm: 12.340,
      dendroValid: 1,
      deltaMm: 0.005,
      dendroStemChangeUm: 5,
      dendroSaturated: 0,
      dendroSaturationSide: null,
      modeCodeToStore: 1,
      modeLabelToStore: 'MOD1',
      observedModeObservedAt: '2026-07-12T09:00:00Z',
    };

    const normalizeResult = normalizer.normalize(decoded, {});
    assert.ok(normalizeResult.channels.ext_temperature_c === 23.5);
    assert.ok(normalizeResult.channels.bat_v === 3.62);
    assert.ok(normalizeResult.channels.swt_1 === 15.2);
    assert.ok(normalizeResult.channels.dendro_position_mm === 12.340);

    const db = createTestDb();
    try {
      db.prepare(
        "UPDATE devices SET type_id = 'DRAGINO_LSN50' WHERE deveui = ?"
      ).run(TEST_DEVEUI);
      writer.resetColumnCache();
      const result = writer.writeDeviceData(db, manifest, normalizeResult, { deveui: TEST_DEVEUI }, {});

      assert.ok(result.columns.length >= 10, 'default mode must write 10+ columns');
      const row = db.prepare('SELECT * FROM device_data WHERE deveui = ? ORDER BY rowid DESC LIMIT 1').get(TEST_DEVEUI);
      assert.ok(row);
      assert.equal(row.ext_temperature_c, 23.5);
      assert.equal(row.bat_v, 3.62);
      assert.equal(row.swt_1, 15.2);
      assert.equal(row.dendro_position_mm, 12.340);
    } finally {
      db.close();
    }
  });

  it('mode 9 rain/flow uplink', () => {
    const decoded = {
      devEui: TEST_DEVEUI,
      detectedMode: 9,
      timestamp: '2026-07-12T10:00:00Z',
      tempC1: 22.1,
      batV: 3.55,
      rainCountCumulative: 100,
      rainTipsDelta: 3,
      rainMmDelta: 0.6,
      rainMmPerHour: 2.4,
      rainMmPer10Min: 0.6,
      rainMmToday: 5.2,
      rainDeltaStatus: 'ok',
      flowCountCumulative: 500,
      flowPulsesDelta: 10,
      flowLitersDelta: 20,
      flowLitersPerMin: 2.0,
      flowLitersPer10Min: 20,
      flowLitersToday: 120,
      flowDeltaStatus: 'ok',
      counterIntervalSeconds: 600,
      modeCodeToStore: 9,
      modeLabelToStore: 'MOD9',
      observedModeObservedAt: '2026-07-12T09:00:00Z',
    };

    const normalizeResult = normalizer.normalize(decoded, {});
    assert.ok(normalizeResult.channels.rain_count_cumulative === 100);
    assert.ok(normalizeResult.channels.flow_liters_today === 120);

    const db = createTestDb();
    try {
      db.prepare(
        "UPDATE devices SET type_id = 'DRAGINO_LSN50' WHERE deveui = ?"
      ).run(TEST_DEVEUI);
      writer.resetColumnCache();
      const result = writer.writeDeviceData(db, manifest, normalizeResult, { deveui: TEST_DEVEUI }, {});

      assert.ok(result.columns.length >= 15, 'mode 9 must write 15+ columns');
      const row = db.prepare('SELECT * FROM device_data WHERE deveui = ? ORDER BY rowid DESC LIMIT 1').get(TEST_DEVEUI);
      assert.ok(row);
      assert.equal(row.rain_count_cumulative, 100);
      assert.equal(row.flow_liters_today, 120);
    } finally {
      db.close();
    }
  });
});

describe('LSN50 normalizer coverage parity with old SQL path', () => {
  const normalizer = require(path.join(NR_ROOT, 'osi-lsn50-normalize'));

  const MODE9_COLS = 'ext_temperature_c bat_v rain_count_cumulative rain_tips_delta rain_mm_delta rain_mm_per_hour rain_mm_per_10min rain_mm_today rain_delta_status flow_count_cumulative flow_pulses_delta flow_liters_delta flow_liters_per_min flow_liters_per_10min flow_liters_today flow_delta_status counter_interval_seconds lsn50_mode_code lsn50_mode_label lsn50_mode_observed_at'.split(' ');
  const DEFAULT_COLS = 'ext_temperature_c bat_v adc_ch0v adc_ch1v swt_1 swt_2 swt_3 dendro_ratio dendro_mode_used dendro_position_raw_mm dendro_position_mm dendro_valid dendro_delta_mm dendro_stem_change_um dendro_saturated dendro_saturation_side lsn50_mode_code lsn50_mode_label lsn50_mode_observed_at'.split(' ');

  it('default mode produces exactly the columns the old SQL wrote', () => {
    const decoded = { detectedMode: 1, tempC1: 1, batV: 1, adcV: 1, adcCh1V: 1, swt1Kpa: 1, swt2Kpa: 1, swt3Kpa: 1, dendroRatio: 1, dendroModeUsed: 'x', positionRawMm: 1, positionMm: 1, dendroValid: 1, deltaMm: 1, dendroStemChangeUm: 1, dendroSaturated: 0, dendroSaturationSide: null, modeCodeToStore: 1, modeLabelToStore: 'MOD1', observedModeObservedAt: '', timestamp: '' };
    const result = normalizer.normalize(decoded, {});
    const normCols = Object.keys(result.channels).sort();
    const expectedCols = DEFAULT_COLS.slice().sort();
    assert.deepEqual(normCols, expectedCols, 'default mode column set must match old SQL exactly');
  });

  it('mode 9 produces exactly the columns the old SQL wrote', () => {
    const decoded = { detectedMode: 9, tempC1: 1, batV: 1, rainCountCumulative: 1, rainTipsDelta: 1, rainMmDelta: 1, rainMmPerHour: 1, rainMmPer10Min: 1, rainMmToday: 1, rainDeltaStatus: '', flowCountCumulative: 1, flowPulsesDelta: 1, flowLitersDelta: 1, flowLitersPerMin: 1, flowLitersPer10Min: 1, flowLitersToday: 1, flowDeltaStatus: '', counterIntervalSeconds: 1, modeCodeToStore: 9, modeLabelToStore: 'MOD9', observedModeObservedAt: '', timestamp: '' };
    const result = normalizer.normalize(decoded, {});
    const normCols = Object.keys(result.channels).sort();
    const expectedCols = MODE9_COLS.slice().sort();
    assert.deepEqual(normCols, expectedCols, 'mode 9 column set must match old SQL exactly');
  });
});
