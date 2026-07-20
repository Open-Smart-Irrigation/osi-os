'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('./index.js');

// Builds the flat object actually assembled by the shipped LSN50 flow node
// (`460e0bfd95f89e67`, "LSN50 Normalize + Write"): every default-mode and
// MOD9 property is always present on the object, with the inactive mode's
// properties left `undefined` because the source ChirpStack payload never
// populated them. `overrides` is applied last so callers can force a
// specific field to a populated value while keeping the rest of the
// production shape intact.
function productionDecoded(overrides) {
  overrides = overrides || {};
  const detectedMode = overrides.detectedMode === undefined ? 1 : overrides.detectedMode;
  const isMode9 = detectedMode === 9;

  const decoded = {
    devEui: 'A84041FF011234AB',
    timestamp: '2026-01-15T10:00:00Z',
    detectedMode: detectedMode,

    // Common to both modes.
    tempC1: 22.3,
    batV: 3.45,

    // Default (soil/dendro) mode fields — undefined while MOD9 is active.
    adcV: isMode9 ? undefined : 1.23,
    adcCh1V: isMode9 ? undefined : 0.45,
    swt1Kpa: isMode9 ? undefined : 15.2,
    swt2Kpa: isMode9 ? undefined : 18.7,
    swt3Kpa: isMode9 ? undefined : null,
    dendroRatio: isMode9 ? undefined : 0.85,
    dendroModeUsed: isMode9 ? undefined : 'linear',
    positionRawMm: isMode9 ? undefined : 12.5,
    positionMm: isMode9 ? undefined : 12.3,
    dendroValid: isMode9 ? undefined : 1,
    deltaMm: isMode9 ? undefined : 0.02,
    dendroStemChangeUm: isMode9 ? undefined : 20,
    dendroSaturated: isMode9 ? undefined : 0,
    dendroSaturationSide: isMode9 ? undefined : null,

    // MOD9 (rain/flow) mode fields — undefined while default mode is active.
    rainCountCumulative: isMode9 ? 150 : undefined,
    rainTipsDelta: isMode9 ? 3 : undefined,
    rainMmDelta: isMode9 ? 0.6 : undefined,
    rainMmPerHour: isMode9 ? 3.6 : undefined,
    rainMmPer10Min: isMode9 ? 0.6 : undefined,
    rainMmToday: isMode9 ? 5.4 : undefined,
    rainDeltaStatus: isMode9 ? 'ok' : undefined,
    flowCountCumulative: isMode9 ? 500 : undefined,
    flowPulsesDelta: isMode9 ? 10 : undefined,
    flowLitersDelta: isMode9 ? 2.5 : undefined,
    flowLitersPerMin: isMode9 ? 15.0 : undefined,
    flowLitersPer10Min: isMode9 ? 150.0 : undefined,
    flowLitersToday: isMode9 ? 1200.0 : undefined,
    flowDeltaStatus: isMode9 ? 'ok' : undefined,
    counterIntervalSeconds: isMode9 ? 600 : undefined,

    // Common to both modes.
    modeCodeToStore: detectedMode,
    modeLabelToStore: isMode9 ? 'rain_flow' : 'soil',
    observedModeObservedAt: '2026-01-15T09:55:00Z',
  };

  return Object.assign(decoded, overrides);
}

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

  describe('production-shaped inactive-mode placeholder classification', () => {
    it('default mode ignores known undefined MOD9 placeholders', () => {
      const result = normalize(productionDecoded({ detectedMode: 1 }));
      assert.deepEqual(result.unknown, {});
    });

    it('MOD9 ignores known undefined default placeholders', () => {
      const result = normalize(productionDecoded({ detectedMode: 9 }));
      assert.deepEqual(result.unknown, {});
    });

    it('default mode ignores known NULL (not just undefined) MOD9 placeholders', () => {
      const decoded = productionDecoded({ detectedMode: 1 });
      for (const key of [
        'rainCountCumulative', 'rainTipsDelta', 'rainMmDelta', 'rainMmPerHour',
        'rainMmPer10Min', 'rainMmToday', 'rainDeltaStatus', 'flowCountCumulative',
        'flowPulsesDelta', 'flowLitersDelta', 'flowLitersPerMin', 'flowLitersPer10Min',
        'flowLitersToday', 'flowDeltaStatus', 'counterIntervalSeconds',
      ]) {
        decoded[key] = null;
      }
      const result = normalize(decoded);
      assert.deepEqual(result.unknown, {});
    });

    it('MOD9 ignores known NULL (not just undefined) default placeholders', () => {
      const decoded = productionDecoded({ detectedMode: 9 });
      for (const key of [
        'adcV', 'adcCh1V', 'swt1Kpa', 'swt2Kpa', 'swt3Kpa', 'dendroRatio',
        'dendroModeUsed', 'positionRawMm', 'positionMm', 'dendroValid', 'deltaMm',
        'dendroStemChangeUm', 'dendroSaturated', 'dendroSaturationSide',
      ]) {
        decoded[key] = null;
      }
      const result = normalize(decoded);
      assert.deepEqual(result.unknown, {});
    });

    it('default mode preserves a populated MOD9-only key as unknown', () => {
      const result = normalize(productionDecoded({ detectedMode: 1, rainCountCumulative: 7 }));
      assert.deepEqual(result.unknown, { rainCountCumulative: 7 });
    });

    it('MOD9 preserves a populated default-only key as unknown', () => {
      const result = normalize(productionDecoded({ detectedMode: 9, adcV: 1.25 }));
      assert.deepEqual(result.unknown, { adcV: 1.25 });
    });

    it('a populated field outside both shipped maps remains unknown', () => {
      const result = normalize({ ...productionDecoded({ detectedMode: 1 }), futureProbe: 7 });
      assert.deepEqual(result.unknown, { futureProbe: 7 });
    });

    it('does not change mapped channel values for either mode', () => {
      const defaultResult = normalize(productionDecoded({ detectedMode: 1 }));
      assert.equal(defaultResult.channels.swt_1, 15.2);
      assert.equal(defaultResult.channels.dendro_position_mm, 12.3);
      assert.ok(!('rain_count_cumulative' in defaultResult.channels));

      const mode9Result = normalize(productionDecoded({ detectedMode: 9 }));
      assert.equal(mode9Result.channels.rain_count_cumulative, 150);
      assert.equal(mode9Result.channels.flow_liters_today, 1200.0);
      assert.ok(!('swt_1' in mode9Result.channels));
    });
  });
});
