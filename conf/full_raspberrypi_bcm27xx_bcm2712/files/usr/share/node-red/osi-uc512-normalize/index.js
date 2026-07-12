'use strict';

const FIELD_MAP = {
  battery: 'bat_pct',
  valve_1: 'valve_1_state',
  valve_2: 'valve_2_state',
  valve_1_pulse: 'valve_1_pulse',
  valve_2_pulse: 'valve_2_pulse',
  pressure: 'pipe_pressure_kpa',
};

function normalize(decoded, meta) {
  var channels = {};
  var unknown = {};

  for (var key in decoded) {
    if (!Object.prototype.hasOwnProperty.call(decoded, key)) continue;
    var mapped = FIELD_MAP[key];
    if (mapped) {
      channels[mapped] = decoded[key];
    } else {
      unknown[key] = decoded[key];
    }
  }

  return {
    channels: channels,
    unknown: unknown,
    recordedAt: (meta && meta.recordedAt) || null,
  };
}

module.exports = { normalize };
