'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('./index.js');

describe('osi-lsn50-normalize', () => {
  it('maps standard soil/dendro mode correctly', () => {
    const decoded = {
      devEui: 'A84041FF011234AB',
      timestamp: '2026-01-15T10:00:00Z',
      detectedMode: 1,
      tempC1: 22.3,
      batV: 3.45,
      adcV: 1.23,
      adcCh1V: 0.45,
      swt1Kpa: 15.2,
      swt2Kpa: 18.7,
      swt3Kpa: null,
      dendroRatio: 0.85,
      dendroModeUsed: 'linear',
      positionRawMm: 12.5,
      positionMm: 12.3,
      dendroValid: true,
      deltaMm: 0.02,
      dendroStemChangeUm: 20,
      dendroSaturated: 0,
      dendroSaturationSide: null,
      modeCodeToStore: 1,
      modeLabelToStore: 'soil',
      observedModeObservedAt: '2026-01-15T09:55:00Z',
    };

    const result = normalize(decoded, {});
    assert.equal(result.channels.ext_temperature_c, 22.3);
    assert.equal(result.channels.bat_v, 3.45);
    assert.equal(result.channels.adc_ch0v, 1.23);
    assert.equal(result.channels.adc_ch1v, 0.45);
    assert.equal(result.channels.swt_1, 15.2);
    assert.equal(result.channels.swt_2, 18.7);
    assert.equal(result.channels.swt_3, null);
    assert.equal(result.channels.dendro_ratio, 0.85);
    assert.equal(result.channels.dendro_mode_used, 'linear');
    assert.equal(result.channels.dendro_position_raw_mm, 12.5);
    assert.equal(result.channels.dendro_position_mm, 12.3);
    assert.equal(result.channels.dendro_valid, true);
    assert.equal(result.channels.dendro_delta_mm, 0.02);
    assert.equal(result.channels.dendro_stem_change_um, 20);
    assert.equal(result.channels.dendro_saturated, 0);
    assert.equal(result.channels.dendro_saturation_side, null);
    assert.equal(result.channels.lsn50_mode_code, 1);
    assert.equal(result.channels.lsn50_mode_label, 'soil');
    assert.equal(result.recordedAt, '2026-01-15T10:00:00Z');
    assert.deepEqual(result.unknown, {});
  });

  it('maps rain/flow mode 9 correctly', () => {
    const decoded = {
      devEui: 'A84041FF011234AB',
      timestamp: '2026-01-15T10:00:00Z',
      detectedMode: 9,
      tempC1: 21.0,
      batV: 3.2,
      rainCountCumulative: 150,
      rainTipsDelta: 3,
      rainMmDelta: 0.6,
      rainMmPerHour: 3.6,
      rainMmPer10Min: 0.6,
      rainMmToday: 5.4,
      rainDeltaStatus: 'ok',
      flowCountCumulative: 500,
      flowPulsesDelta: 10,
      flowLitersDelta: 2.5,
      flowLitersPerMin: 15.0,
      flowLitersPer10Min: 150.0,
      flowLitersToday: 1200.0,
      flowDeltaStatus: 'ok',
      counterIntervalSeconds: 600,
      modeCodeToStore: 9,
      modeLabelToStore: 'rain_flow',
      observedModeObservedAt: '2026-01-15T09:55:00Z',
    };

    const result = normalize(decoded, {});
    assert.equal(result.channels.ext_temperature_c, 21.0);
    assert.equal(result.channels.bat_v, 3.2);
    assert.equal(result.channels.rain_count_cumulative, 150);
    assert.equal(result.channels.rain_tips_delta, 3);
    assert.equal(result.channels.flow_liters_per_min, 15.0);
    assert.equal(result.channels.counter_interval_seconds, 600);
    assert.equal(result.channels.lsn50_mode_code, 9);
    assert.ok(!('swt_1' in result.channels));
    assert.ok(!('dendro_ratio' in result.channels));
    assert.deepEqual(result.unknown, {});
  });

  it('routes unknown fields to unknown', () => {
    const decoded = {
      devEui: 'A84041FF011234AB',
      timestamp: '2026-01-15T10:00:00Z',
      detectedMode: 1,
      tempC1: 20,
      batV: 3.0,
      someNewField: 42,
    };

    const result = normalize(decoded, {});
    assert.equal(result.channels.ext_temperature_c, 20);
    assert.equal(result.unknown.someNewField, 42);
  });

  it('does not route envelope fields (devEui, timestamp, detectedMode) to unknown', () => {
    const decoded = {
      devEui: 'AABBCCDD',
      timestamp: '2026-01-01T00:00:00Z',
      detectedMode: 1,
      tempC1: 15,
      batV: 3.1,
    };

    const result = normalize(decoded, {});
    assert.ok(!('devEui' in result.unknown));
    assert.ok(!('timestamp' in result.unknown));
    assert.ok(!('detectedMode' in result.unknown));
  });

  it('uses decoded.timestamp for recordedAt', () => {
    const result = normalize({ devEui: 'X', timestamp: '2026-07-12T12:00:00Z', detectedMode: 1 }, {});
    assert.equal(result.recordedAt, '2026-07-12T12:00:00Z');
  });
});
