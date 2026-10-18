'use strict';

// Versioned, provisional interpretation for offline preparation. Existing devices
// continue through index.js normalize() until revision-aware acquisition is wired.
const crypto = require('crypto');
const legacy = require('./index');
const manifest = require('../edge-channels.json');
const manifestByKey = new Map(manifest.map(entry => [entry.key, entry]));

// These rule objects are both evaluated and hashed. Their versioned digest pins
// live in configuration.test.js; change the profile version when semantics change.
const VWC_PERCENT = { transform: { kind: 'identity' }, range: [0, 100], range_failure: 'channel' };
const TEROS_VWC = {
  transform: { kind: 'linear', scale: 3.879e-4, offset: -0.6956, multiplier: 100 },
  range: [0, 70], range_failure: 'channel',
};
const TEROS_TEMP = { transform: { kind: 'identity' }, range: [-40, 60], range_failure: 'vector' };
const TEROS_EC = { transform: { kind: 'identity' }, range: [0, 20000], range_failure: 'vector' };
const CANDIDATES = {
  DELTAT_PR2_4: { version: 2, depthCount: 4, keys: ['vwc_1', 'vwc_2', 'vwc_3', 'vwc_4'],
    family: 'pr2', rules: Array(4).fill(VWC_PERCENT), sentinels: [] },
  DELTAT_PR2_6: { version: 2, depthCount: 6, keys: ['vwc_1', 'vwc_2', 'vwc_3', 'vwc_4', 'vwc_5', 'vwc_6'],
    family: 'pr2', rules: Array(6).fill(VWC_PERCENT), sentinels: [] },
  METER_TEROS_11: { version: 2, depthCount: 1, keys: ['vwc_1', 'soil_temp_1'],
    family: 'teros', rules: [TEROS_VWC, TEROS_TEMP], sentinels: [-9999, -9992, -9991] },
  METER_TEROS_12: { version: 2, depthCount: 1, keys: ['vwc_1', 'soil_temp_1', 'soil_ec_1'],
    family: 'teros', rules: [TEROS_VWC, TEROS_TEMP, TEROS_EC], sentinels: [-9999, -9992, -9991] },
  // Offline preview model only (acquisition_available: false), superseded for
  // live data by tensiomark-live.js and matric-potential contract v1, which
  // convert with pfToKpa (hPa convention) and no extra decimal rounding. Its
  // `10 ** raw / divisor` with two-decimal rounding must not be wired live.
  TENSIOMARK: { version: 3, depthCount: 1, keys: ['swt_1', 'soil_temp_1'], family: 'tensiomark', sentinels: [],
    rules: [
      { transform: { kind: 'pf_to_kpa', divisor: 10 }, source_range: [0, 7],
        range: [0.1, 1000000], range_failure: 'vector' },
      { transform: { kind: 'identity' }, range: [-40, 80], range_failure: 'vector' },
    ] },
};

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return object(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}

function failure(code) { return { ok: false, code }; }
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function detached(value) { return JSON.parse(JSON.stringify(value)); }

function validDepth(value) {
  return Number.isInteger(value) && value >= 1 && value <= 1000;
}

function channel(key, depth, index) {
  const entry = manifestByKey.get(key);
  if (!entry || entry.edgeField !== key) throw new Error('missing_manifest_channel:' + key);
  return { key, unit: entry.unit, depth_cm: depth, source_index: index };
}

function canonicalSettings(family, settings) {
  if (family === 'pr2') {
    if (!exactKeys(settings, ['measurement_mode']) || settings.measurement_mode !== 'mineral_vwc_percent') return null;
    return { measurement_mode: settings.measurement_mode };
  }
  if (family === 'teros') {
    if (!exactKeys(settings, ['calibration']) || settings.calibration !== 'mineral') return null;
    return { calibration: settings.calibration };
  }
  if (!exactKeys(settings, ['source_unit', 'variant', 'field_order'])
    || settings.source_unit !== 'pF' || settings.variant !== '1'
    || !['pf_temperature', 'temperature_pf'].includes(settings.field_order)) return null;
  return { source_unit: settings.source_unit, variant: settings.variant, field_order: settings.field_order };
}

function resolveConfiguration(input) {
  if (!exactKeys(input, ['version', 'profile_id', 'profile_version', 'address', 'settings', 'depths'])) {
    return failure('invalid_configuration');
  }
  if (input.version !== 1) return failure('unsupported_version');
  if (input.profile_id === 'HYDRASCOUT') return failure('protocol_evidence_required');
  if (typeof input.profile_id !== 'string' || !Object.prototype.hasOwnProperty.call(CANDIDATES, input.profile_id)) {
    return failure('unknown_profile');
  }
  if (typeof input.address !== 'string' || !/^[0-9A-Za-z]$/.test(input.address)) return failure('invalid_address');
  const definition = CANDIDATES[input.profile_id];
  if (input.profile_version !== definition.version) return failure('unsupported_profile_version');
  if (definition.family === 'tensiomark' && object(input.settings)
    && (['hPa', 'mbar', 'kPa'].includes(input.settings.source_unit) || ['2', '3'].includes(input.settings.variant))) {
    return failure('protocol_evidence_required');
  }
  const settings = canonicalSettings(definition.family, input.settings);
  if (!settings) return failure('invalid_settings');
  if (!Array.isArray(input.depths) || input.depths.length !== definition.depthCount
    || !Array.from(input.depths).every(validDepth) || new Set(input.depths).size !== input.depths.length) {
    return failure('invalid_depths');
  }
  const configuration = {
    version: 1, profile_id: input.profile_id, profile_version: definition.version,
    address: input.address, settings, depths: input.depths.slice(),
  };
  // Explicit offline assumption only; neither order establishes installed firmware.
  const sourceIndexes = definition.keys.map((key, index) =>
    definition.family === 'tensiomark' && settings.field_order === 'temperature_pf' ? 1 - index : index);
  const interpretation = {
    profile_id: input.profile_id, profile_version: definition.version, settings: detached(settings),
    parser: 'strict_sign_delimited_v1', rounding: { kind: 'math_round', decimal_places: 2 },
    fatal_errors: ['framing', 'count', 'not_finite', 'sensor_error'],
    sentinels: definition.sentinels.slice(),
    rules: definition.rules.map((rule, index) => {
      const entry = channel(definition.keys[index], null, sourceIndexes[index]);
      return { key: entry.key, unit: entry.unit, source_index: entry.source_index, ...detached(rule) };
    }),
  };
  const interpretationHash = hash(interpretation);
  return {
    ok: true,
    configuration,
    channels: definition.keys.map((key, index) => channel(key,
      configuration.depths[definition.depthCount === 1 ? 0 : index], sourceIndexes[index])),
    expected_values: definition.keys.length,
    interpretation,
    interpretation_hash: interpretationHash,
    configuration_hash: hash({ configuration, interpretation_hash: interpretationHash }),
    provisional: true,
    acquisition_available: false,
  };
}

function resolveLegacyConfiguration(input) {
  if (!object(input)) return failure('invalid_configuration');
  const profile = legacy.getProfile(input.probeProfile);
  if (!profile) return failure('unknown_profile');
  if (profile.id === 'TENSIOMARK') return failure('protocol_evidence_required');
  const learned = Number.isInteger(input.sdi12ValueCount) && input.sdi12ValueCount >= 1
    && input.sdi12ValueCount <= 8 ? input.sdi12ValueCount : null;
  let expected = profile.expectedValues == null ? learned : profile.expectedValues;
  let entries = profile.values;
  let depths = object(input.depths) ? input.depths : {};
  let validLegacyDepth = value => Number.isFinite(value) && value >= 0 && value <= 500;
  if (profile.id === 'SENTEK_ENVIROSCAN' && input.sdi12ChannelLayout != null) {
    const validated = legacy.validateSentekLayout(input.sdi12ChannelLayout);
    if (!validated.ok) return failure('invalid_legacy_layout');
    const sensors = validated.layout.sensors;
    entries = sensors.map((sensor, index) => ({ channel: 'vwc_' + sensor.channel, index }));
    for (const sensor of sensors.filter(sensor => sensor.type === 'TRISCAN')) {
      entries.push({ channel: 'soil_vic_' + sensor.channel, index: entries.length });
    }
    expected = entries.length;
    depths = validated.depths;
    validLegacyDepth = validDepth;
  } else if (learned !== null && profile.expectedValues == null) {
    entries = profile.values.slice(0, learned);
  }
  return {
    ok: true, legacy: true, profile_id: profile.id, profile_version: 0,
    expected_values: expected,
    channels: entries.map(entry => channel(entry.channel,
      validLegacyDepth(depths[entry.channel]) ? depths[entry.channel] : null, entry.index)),
  };
}

function within(value, min, max) { return Number.isFinite(value) && value >= min && value <= max; }

function candidateValue(rule, raw, interpretation) {
  if (!Number.isFinite(raw)) return { error: 'not_finite' };
  if (interpretation.sentinels.includes(raw)) return { error: 'sensor_error' };
  if (rule.source_range && !within(raw, ...rule.source_range)) return { error: 'source_out_of_range' };
  let value = raw;
  if (rule.transform.kind === 'linear') {
    value = (rule.transform.scale * raw + rule.transform.offset) * rule.transform.multiplier;
  } else if (rule.transform.kind === 'pf_to_kpa') {
    value = 10 ** raw / rule.transform.divisor;
  } else if (rule.transform.kind !== 'identity') {
    return { error: 'unknown_transform' };
  }
  if (!Number.isFinite(value)) return { error: 'not_finite' };
  if (!within(value, ...rule.range)) return { error: 'out_of_range', partial: rule.range_failure === 'channel' };
  const factor = 10 ** interpretation.rounding.decimal_places;
  return { value: Math.round(value * factor) / factor || 0 };
}

function normalizeConfigured(decoded, input, meta) {
  const result = {
    channels: {}, unknown: {}, recordedAt: (meta && meta.recordedAt) || null,
    noResponse: false, disposition: 'quarantined', configuration_hash: null,
  };
  function quarantine() {
    if (input && input.profile_id === 'TENSIOMARK' && decoded && typeof decoded.data_sum === 'string') {
      result.unknown.sdi12_tensiomark_raw = decoded.data_sum;
    }
    return result;
  }
  if (decoded && Number.isFinite(decoded.BatV)) result.channels.bat_v = decoded.BatV;
  const resolved = resolveConfiguration(input);
  if (!resolved.ok) {
    result.unknown.sdi12_configuration = resolved.code;
    return quarantine();
  }
  result.configuration_hash = resolved.configuration_hash;
  const raw = decoded && typeof decoded.data_sum === 'string' ? decoded.data_sum.trim() : '';
  if (raw === '' || raw === 'NULL') {
    result.noResponse = true;
    result.disposition = 'no_response';
    return result;
  }
  const values = legacy.parseSdi12Values(raw);
  if (!values) {
    result.unknown.unparseable_sdi12 = raw;
    return quarantine();
  }
  if (values.length !== resolved.expected_values) {
    result.unknown.sdi12_value_count = raw;
    return quarantine();
  }
  const staged = {};
  let fatal = false;
  for (const entry of resolved.interpretation.rules) {
    const rawValue = values[entry.source_index];
    const value = candidateValue(entry, rawValue, resolved.interpretation);
    if (value.error) {
      result.unknown[entry.key + ':' + value.error] = Number.isFinite(rawValue) ? rawValue : String(rawValue);
      if (!value.partial) fatal = true;
    } else {
      staged[entry.key] = value.value;
    }
  }
  if (fatal || Object.keys(staged).length === 0) return quarantine();
  Object.assign(result.channels, staged);
  result.disposition = Object.keys(result.unknown).length ? 'partial' : 'complete';
  return result;
}

module.exports = { resolveConfiguration, resolveLegacyConfiguration, normalizeConfigured };
