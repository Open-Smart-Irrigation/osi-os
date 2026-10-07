'use strict';

const crypto = require('node:crypto');

const DEVICE_TYPE_IDS = Object.freeze([
  'KIWI_SENSOR', 'STREGA_VALVE', 'DRAGINO_LSN50', 'TEKTELIC_CLOVER',
  'SENSECAP_S2120', 'AQUASCOPE_LORAIN', 'MILESIGHT_UC512', 'DRAGINO_SDI12',
  'RAK10701_FIELD_TESTER',
]);

const LO_RAIN_CHANNELS = Object.freeze([
  'ambient_temperature', 'rain_tips_delta', 'rain_mm_delta', 'rain_mm_today',
  'rain_mm_per_hour', 'rain_mm_per_10min', 'bat_v',
]);
const SOIL_CHANNELS = Object.freeze([
  'swt_1', 'swt_2', 'swt_3',
  ...Array.from({ length: 10 }, (_, index) => `vwc_${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `soil_vic_${index + 1}`),
  ...Array.from({ length: 8 }, (_, index) => `soil_temp_${index + 1}`),
  ...Array.from({ length: 8 }, (_, index) => `soil_ec_${index + 1}`),
]);
// Union of fields actually emitted by the shipped SDI-12 normalizer profiles:
// variable VWC (up to ten for a configured Sentek rail), TriSCAN VIC, and the
// fixed Tensiomark/IMKO/HydraScout layouts. Do not advertise every soil column
// in device_data as an SDI-12 capability.
const SDI12_CHANNELS = Object.freeze([
  ...Array.from({ length: 10 }, (_, index) => `vwc_${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `soil_vic_${index + 1}`),
  'swt_1', 'soil_temp_1', 'soil_temp_2', 'soil_ec_1', 'soil_ec_2',
]);
const CLIMATE_CHANNELS = Object.freeze(['ambient_temperature', 'relative_humidity', 'light_lux']);
const WEATHER_CHANNELS = Object.freeze([
  'wind_speed_mps', 'wind_gust_mps', 'barometric_pressure_hpa', 'uv_index',
  'rain_count_cumulative', 'rain_tips_delta', 'rain_gauge_cumulative_mm',
  'rain_mm_per_hour', 'rain_mm_per_10min', 'rain_mm_today', 'rain_mm_delta',
  'wind_direction_deg', 'pipe_pressure_kpa',
]);
const SENSECAP_CHANNELS = Object.freeze([
  ...CLIMATE_CHANNELS,
  ...WEATHER_CHANNELS.filter((key) => key !== 'pipe_pressure_kpa'),
  'bat_v',
]);
const FLOW_CHANNELS = Object.freeze([
  'flow_liters_per_min', 'flow_liters_per_10min', 'flow_liters_today',
  'flow_liters_delta', 'flow_count_cumulative', 'flow_pulses_delta',
]);
const DENDRO_CHANNELS = Object.freeze([
  'dendro_stem_change_um', 'dendro_position_mm', 'dendro_position_raw_mm',
  'dendro_delta_mm', 'dendro_ratio', 'adc_ch0v', 'adc_ch1v',
]);
const HEALTH_CHANNELS = Object.freeze(['bat_v', 'bat_pct']);
const VALVE_PULSE_CHANNELS = Object.freeze(['valve_1_pulse', 'valve_2_pulse']);

const DEVICE_POLICIES = Object.freeze({
  KIWI_SENSOR: { families: [['soil', ['swt_1', 'swt_2']], ['environment', CLIMATE_CHANNELS], ['device_health', HEALTH_CHANNELS]] },
  TEKTELIC_CLOVER: { families: [['environment', CLIMATE_CHANNELS], ['device_health', HEALTH_CHANNELS]] },
  SENSECAP_S2120: { families: [['environment', SENSECAP_CHANNELS.filter((key) => key !== 'bat_v')], ['device_health', ['bat_v']]] },
  AQUASCOPE_LORAIN: { families: [['environment', LO_RAIN_CHANNELS.slice(0, -1)], ['device_health', ['bat_v']]] },
  MILESIGHT_UC512: { families: [['environment', ['pipe_pressure_kpa']], ['device_health', ['bat_pct', ...VALVE_PULSE_CHANNELS]]], limitation: 'valve_events' },
  RAK10701_FIELD_TESTER: { families: [], presentation: 'specialized', destination: 'network' },
});

const STREGA_CHANNELS = Object.freeze(['ambient_temperature', 'relative_humidity', ...HEALTH_CHANNELS]);

function parseObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function bool(value) {
  return value === true || value === 1 || String(value || '').trim().toLowerCase() === 'true';
}

function typeId(device) {
  return String(device && (device.type_id || device.typeId || device.type) || '').trim().toUpperCase();
}

function addUnique(target, keys) {
  for (const key of keys) if (!target.includes(key)) target.push(key);
}

function sdi12Channels(device) {
  const supported = SDI12_CHANNELS;
  const depths = parseObject(device && (device.soil_moisture_probe_depths_json || device.soilMoistureProbeDepthsJson));
  const layout = parseObject(device && (device.sdi12_channel_layout_json || device.sdi12ChannelLayoutJson));
  const current = [];
  if (depths) addUnique(current, Object.keys(depths).filter((key) => supported.includes(key)));
  if (!current.length && layout && Array.isArray(layout.sensors)) {
    for (const sensor of layout.sensors) {
      const channel = Number(sensor && sensor.channel);
      if (!Number.isInteger(channel) || channel < 1 || channel > 10) continue;
      addUnique(current, [`vwc_${channel}`]);
      if (String(sensor.type || '').toUpperCase() === 'TRISCAN') addUnique(current, [`soil_vic_${channel}`]);
    }
  }
  const profile = String(device && (device.sdi12_probe_profile || device.sdi12ProbeProfile) || '').trim().toUpperCase();
  if (!current.length && profile === 'TENSIOMARK') addUnique(current, ['swt_1', 'soil_temp_1']);
  if (!current.length && profile === 'IMKO_PICO64') addUnique(current, ['vwc_1', 'soil_temp_1']);
  if (!current.length && profile === 'HYDRASCOUT') addUnique(current, ['vwc_1', 'soil_temp_1', 'soil_ec_1', 'vwc_2', 'soil_temp_2', 'soil_ec_2']);
  addUnique(current, ['bat_v']);
  return { declared: supported, current };
}

function lsn50Channels(device) {
  const current = [];
  const chameleon = bool(device && (device.chameleon_enabled ?? device.chameleonEnabled));
  const watermark = bool(device && (device.watermark_evidence ?? device.watermarkEvidence));
  const temp = bool(device && (device.temp_enabled ?? device.tempEnabled));
  const rain = bool(device && (device.rain_gauge_enabled ?? device.rainGaugeEnabled));
  const flow = bool(device && (device.flow_meter_enabled ?? device.flowMeterEnabled));
  const dendro = bool(device && (device.dendro_enabled ?? device.dendroEnabled));
  if (chameleon) addUnique(current, ['swt_1', 'swt_2', 'swt_3']);
  else if (watermark || (!temp && !rain && !flow && !dendro)) addUnique(current, ['swt_1', 'swt_2']);
  if (temp) addUnique(current, ['ext_temperature_c']);
  if (rain) addUnique(current, ['rain_count_cumulative', 'rain_tips_delta', 'rain_gauge_cumulative_mm', 'rain_mm_per_hour', 'rain_mm_per_10min', 'rain_mm_today', 'rain_mm_delta']);
  if (flow) addUnique(current, FLOW_CHANNELS);
  if (dendro) addUnique(current, DENDRO_CHANNELS);
  addUnique(current, ['bat_v']);
  return {
    families: [
      ['soil', ['swt_1', 'swt_2', 'swt_3']],
      ['environment', ['ext_temperature_c', ...WEATHER_CHANNELS.filter((key) => key.startsWith('rain_')), ...FLOW_CHANNELS]],
      ['dendro', DENDRO_CHANNELS],
      ['device_health', ['bat_v']],
    ],
    current,
  };
}

function stregaChannels(device) {
  const generation = String(device && (device.valve_generation || device.strega_generation || device.generation) || 'GEN1').trim().toUpperCase();
  return {
    families: [['device_health', STREGA_CHANNELS]],
    // Gen2 carries battery voltage, while the enclosure telemetry keys are
    // historical candidates until that profile reports them. Gen1 reports
    // the vendor battery percentage and enclosure climate.
    current: generation === 'GEN2'
      ? ['bat_v']
      : ['bat_pct', 'ambient_temperature', 'relative_humidity'],
  };
}

function describeDeviceSource(device = {}) {
  const type = typeId(device);
  let policy = DEVICE_POLICIES[type];
  let families;
  let currentChannelKeys;
  let presentation;
  let destination = null;
  let limitation = null;
  if (type === 'DRAGINO_LSN50') {
    const lsn = lsn50Channels(device);
    families = lsn.families;
    currentChannelKeys = lsn.current;
  } else if (type === 'DRAGINO_SDI12') {
    const sdi = sdi12Channels(device);
    families = [['soil', sdi.declared], ['device_health', ['bat_v']]];
    currentChannelKeys = sdi.current;
  } else if (type === 'STREGA_VALVE') {
    const strega = stregaChannels(device);
    families = strega.families;
    currentChannelKeys = strega.current;
    limitation = 'valve_events';
  } else if (policy) {
    families = policy.families;
    currentChannelKeys = families.flatMap(([, keys]) => keys);
    if (type === 'KIWI_SENSOR' && bool(device.chameleon_enabled ?? device.chameleonEnabled)) {
      families = families.map(([cardType, keys]) => cardType === 'soil' ? [cardType, [...keys, 'swt_3']] : [cardType, keys]);
      currentChannelKeys = currentChannelKeys.concat('swt_3');
    }
    presentation = policy.presentation;
    destination = policy.destination || null;
    limitation = policy.limitation || null;
  } else {
    families = [];
    currentChannelKeys = [];
    presentation = 'unsupported';
    limitation = 'unsupported_type';
  }
  const normalizedFamilies = families.map(([cardType, channelKeys]) => ({ cardType, channelKeys: Array.from(new Set(channelKeys)) }));
  return {
    families: normalizedFamilies,
    currentChannelKeys: Array.from(new Set(currentChannelKeys)),
    presentation: presentation || (normalizedFamilies.some((family) => family.channelKeys.length) ? 'timeseries' : 'unsupported'),
    destination,
    limitation,
  };
}

function normalizeDeviceEui(value) {
  const normalized = String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return /^[0-9A-F]{16}$/.test(normalized) ? normalized : null;
}

function deviceSourceId(device = {}) {
  const rawEui = device && (device.deveui || device.device_eui || device.deviceEui);
  if (!String(rawEui || '').trim()) throw new Error('cannot create device source for empty EUI');
  const eui = normalizeDeviceEui(rawEui);
  if (!eui) throw new Error('cannot create device source for invalid EUI');
  return `device-${crypto.createHash('sha256').update(eui).digest('hex').slice(0, 12)}`;
}

module.exports = {
  DEVICE_TYPE_IDS,
  DEVICE_POLICIES,
  LO_RAIN_CHANNELS,
  SOIL_CHANNELS,
  deviceSourceId,
  describeDeviceSource,
};
