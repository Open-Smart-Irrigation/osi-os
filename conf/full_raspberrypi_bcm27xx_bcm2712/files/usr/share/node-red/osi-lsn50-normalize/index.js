'use strict';

function v(x) { return x !== undefined && x !== null ? x : null; }

var MODE9_MAP = {
  tempC1: 'ext_temperature_c',
  batV: 'bat_v',
  rainCountCumulative: 'rain_count_cumulative',
  rainTipsDelta: 'rain_tips_delta',
  rainMmDelta: 'rain_mm_delta',
  rainMmPerHour: 'rain_mm_per_hour',
  rainMmPer10Min: 'rain_mm_per_10min',
  rainMmToday: 'rain_mm_today',
  rainDeltaStatus: 'rain_delta_status',
  flowCountCumulative: 'flow_count_cumulative',
  flowPulsesDelta: 'flow_pulses_delta',
  flowLitersDelta: 'flow_liters_delta',
  flowLitersPerMin: 'flow_liters_per_min',
  flowLitersPer10Min: 'flow_liters_per_10min',
  flowLitersToday: 'flow_liters_today',
  flowDeltaStatus: 'flow_delta_status',
  counterIntervalSeconds: 'counter_interval_seconds',
  modeCodeToStore: 'lsn50_mode_code',
  modeLabelToStore: 'lsn50_mode_label',
  observedModeObservedAt: 'lsn50_mode_observed_at',
};

var DEFAULT_MAP = {
  tempC1: 'ext_temperature_c',
  batV: 'bat_v',
  adcV: 'adc_ch0v',
  adcCh1V: 'adc_ch1v',
  swt1Kpa: 'swt_1',
  swt2Kpa: 'swt_2',
  swt3Kpa: 'swt_3',
  dendroRatio: 'dendro_ratio',
  dendroModeUsed: 'dendro_mode_used',
  positionRawMm: 'dendro_position_raw_mm',
  positionMm: 'dendro_position_mm',
  dendroValid: 'dendro_valid',
  deltaMm: 'dendro_delta_mm',
  dendroStemChangeUm: 'dendro_stem_change_um',
  dendroSaturated: 'dendro_saturated',
  dendroSaturationSide: 'dendro_saturation_side',
  modeCodeToStore: 'lsn50_mode_code',
  modeLabelToStore: 'lsn50_mode_label',
  observedModeObservedAt: 'lsn50_mode_observed_at',
};

var ENVELOPE_KEYS = { devEui: 1, timestamp: 1, detectedMode: 1 };

function normalize(decoded, meta) {
  var map = decoded.detectedMode === 9 ? MODE9_MAP : DEFAULT_MAP;
  var channels = {};
  var unknown = {};

  for (var srcKey in map) {
    channels[map[srcKey]] = v(decoded[srcKey]);
  }

  for (var key in decoded) {
    if (!Object.prototype.hasOwnProperty.call(decoded, key)) continue;
    if (ENVELOPE_KEYS[key]) continue;
    if (!map[key]) {
      unknown[key] = decoded[key];
    }
  }

  return {
    channels: channels,
    unknown: unknown,
    recordedAt: decoded.timestamp || (meta && meta.recordedAt) || null,
  };
}

module.exports = { normalize };
