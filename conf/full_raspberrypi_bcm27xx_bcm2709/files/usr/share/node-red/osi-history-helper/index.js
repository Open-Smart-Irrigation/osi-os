'use strict';

const crypto = require('crypto');
const { createAnalysis } = require('./analysis');
const { deviceSourceId, describeDeviceSource } = require('./device-sources');
// The sibling module resolves the same way on the gateway (/srv/node-red/<name>)
// as in the repo; osi-weather-provider requires nothing back, so there is no cycle.
const { zoneLocations } = require('../osi-weather-provider');

const DEFAULT_SOURCE_KEYS = {
  soil: 'root-zone',
  environment: 'microclimate',
  irrigation: 'zone-valves',
  gateway: 'hub',
};

const BUCKET_SECONDS = {
  '15m': 15 * 60,
  hourly: 60 * 60,
  daily: 24 * 60 * 60,
  weekly: 7 * 24 * 60 * 60,
};

const CADENCE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const ALLOWED_AGGREGATIONS = new Set(['raw', '15m', 'hourly', 'daily', 'weekly']);

const ROLLUP_WINDOWS = {
  hourly: 8 * 24 * 60 * 60 * 1000,
  daily: 120 * 24 * 60 * 60 * 1000,
  weekly: 370 * 24 * 60 * 60 * 1000,
};

const ALLOWED_DEVICE_DATA_CHANNELS = new Set([
  'swt_1',
  'swt_2',
  'swt_3',
  'swt_wm1',
  'swt_wm2',
  'vwc_1',
  'vwc_2',
  'vwc_3',
  'vwc_4',
  'vwc_5',
  'vwc_6',
  'vwc_7',
  'vwc_8',
  'vwc_9',
  'vwc_10',
  'soil_vic_1',
  'soil_vic_2',
  'soil_vic_3',
  'soil_vic_4',
  'soil_vic_5',
  'soil_vic_6',
  'soil_vic_7',
  'soil_vic_8',
  'soil_vic_9',
  'soil_vic_10',
  'soil_temp_1',
  'soil_temp_2',
  'soil_temp_3',
  'soil_temp_4',
  'soil_temp_5',
  'soil_temp_6',
  'soil_temp_7',
  'soil_temp_8',
  'soil_ec_1',
  'soil_ec_2',
  'soil_ec_3',
  'soil_ec_4',
  'soil_ec_5',
  'soil_ec_6',
  'soil_ec_7',
  'soil_ec_8',
  'ambient_temperature',
  'relative_humidity',
  'ext_temperature_c',
  'light_lux',
  'rain_mm_per_hour',
  'rain_mm_per_10min',
  'rain_mm_today',
  'rain_mm_delta',
  'wind_speed_mps',
  'wind_gust_mps',
  'barometric_pressure_hpa',
  'uv_index',
  'bat_v',
  'bat_pct',
  'adc_ch0v',
  'adc_ch1v',
  'dendro_position_mm',
  'dendro_position_raw_mm',
  'dendro_delta_mm',
  'dendro_stem_change_um',
  'dendro_ratio',
  'dendro_valid',
  'dendro_mode_used',
  'dendro_saturated',
  'dendro_saturation_side',
  'lsn50_mode_code',
  'lsn50_mode_label',
  'lsn50_mode_observed_at',
  'rain_count_cumulative',
  'rain_tips_delta',
  'rain_gauge_cumulative_mm',
  'rain_delta_status',
  'flow_liters_per_min',
  'flow_liters_per_10min',
  'flow_liters_today',
  'flow_liters_delta',
  'flow_count_cumulative',
  'flow_pulses_delta',
  'flow_delta_status',
  'counter_interval_seconds',
  'wind_direction_deg',
  'valve_1_state',
  'valve_2_state',
  'valve_1_pulse',
  'valve_2_pulse',
  'pipe_pressure_kpa',
]);

const LEGACY_SENSOR_HISTORY_FIELDS = new Set([
  ...ALLOWED_DEVICE_DATA_CHANNELS,
  'rain_count_cumulative',
  'rain_tips_delta',
  'flow_count_cumulative',
  'flow_pulses_delta',
  'flow_liters_delta',
  'flow_liters_per_min',
  'flow_liters_per_10min',
  'flow_liters_today',
  'counter_interval_seconds',
  'wind_direction_deg',
  'rain_gauge_cumulative_mm',
]);

const VALID_EXPORT_CHANNEL_KEYS = new Set([
  'swt_1',
  'swt_2',
  'swt_3',
  'vwc_1',
  'vwc_2',
  'vwc_3',
  'vwc_4',
  'vwc_5',
  'vwc_6',
  'vwc_7',
  'vwc_8',
  'vwc_9',
  'vwc_10',
  'soil_vic_1',
  'soil_vic_2',
  'soil_vic_3',
  'soil_vic_4',
  'soil_vic_5',
  'soil_vic_6',
  'soil_vic_7',
  'soil_vic_8',
  'soil_vic_9',
  'soil_vic_10',
  'soil_temp_1',
  'soil_temp_2',
  'soil_temp_3',
  'soil_temp_4',
  'soil_temp_5',
  'soil_temp_6',
  'soil_temp_7',
  'soil_temp_8',
  'soil_ec_1',
  'soil_ec_2',
  'soil_ec_3',
  'soil_ec_4',
  'soil_ec_5',
  'soil_ec_6',
  'soil_ec_7',
  'soil_ec_8',
  'vwc',
  'ambient_temperature',
  'relative_humidity',
  'light_lux',
  'ext_temperature_c',
  'rain_mm_per_hour',
  'rain_mm_per_10min',
  'rain_mm_today',
  'rain_mm_delta',
  'wind_speed_mps',
  'wind_gust_mps',
  'barometric_pressure_hpa',
  'uv_index',
  'dendro_stem_change_um',
  'dendro_position_mm',
  'dendro_position_raw_mm',
  'dendro_delta_mm',
  'dendro_ratio',
  'adc_ch0v',
  'adc_ch1v',
  'rain_count_cumulative',
  'rain_tips_delta',
  'rain_gauge_cumulative_mm',
  'flow_liters_per_min',
  'flow_liters_per_10min',
  'flow_liters_today',
  'flow_liters_delta',
  'flow_count_cumulative',
  'flow_pulses_delta',
  'wind_direction_deg',
  'pipe_pressure_kpa',
  'global_radiation_wm2',
  'et0_mm',
  'etc_mm',
]);

const LEGACY_CHANNEL_ALIASES = {
  swt_wm1: 'swt_1',
  swt_wm2: 'swt_2',
  temperature: 'ambient_temperature',
  humidity: 'relative_humidity',
  light: 'light_lux',
};

const LEGACY_FIELD_ALIASES = {
  swt_wm1: 'swt_1',
  swt_wm2: 'swt_2',
};

const LEGACY_FIELD_EXPRESSIONS = {
  swt_wm1: 'COALESCE(dd.swt_1, dd.swt_wm1)',
  swt_wm2: 'COALESCE(dd.swt_2, dd.swt_wm2)',
  swt_1: 'COALESCE(dd.swt_1, dd.swt_wm1)',
  swt_2: 'COALESCE(dd.swt_2, dd.swt_wm2)',
  swt_3: 'dd.swt_3',
};

const DENDRO_HISTORY_FIELDS = [
  'dendro_position_raw_mm',
  'dendro_position_mm',
  'dendro_delta_mm',
  'dendro_stem_change_um',
  'adc_ch0v',
  'adc_ch1v',
  'dendro_ratio',
];

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundTo(value, decimals = 3) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(number * factor) / factor;
}

// Tension at or below which pF takes its floor of 0 (log10(0.1 * 10) = 0).
const PF_FLOOR_KPA = 0.1;

// pF = log10(tension in hPa); 1 kPa = 10 hPa. pF is never written below 0:
// a finite tension at or below 0.1 kPa (where the formula gives 0, a negative
// or no value, e.g. a saturated probe at 0 kPa) derives the 0 pF floor.
// A missing or non-finite reading stays null and gets no pF row.
function kpaToPf(kpa) {
  const value = toFiniteNumber(kpa);
  if (value === null) return null;
  if (value <= PF_FLOOR_KPA) return 0;
  return Math.log10(value * 10);
}

function isSwtKpaChannel(channel) {
  return Boolean(channel) && channel.unit === 'kPa' && /^swt_/.test(String(channel.id || ''));
}

function pfExportRow(kpaRow, channel) {
  const pf = kpaToPf(kpaRow.value);
  if (pf === null) return null;
  return {
    ...kpaRow,
    series_label: `${kpaRow.series_label} (pF)`,
    channel_key: `${channel.id}_pf`,
    unit: 'pF',
    value: roundTo(pf, 4),
  };
}

function parseTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// device_data.recorded_at is TEXT, and gateways hold more than one shape in
// it: toISOString ('2026-08-17T17:47:12.123Z'), the uplink's RFC 3339 time
// ('2026-08-17T17:47:12.123456789+00:00', also without a fraction) and
// SQLite's 'YYYY-MM-DD HH:MM:SS'. Text order is not time order across those
// shapes: a row in the same millisecond as a bound, or any space-separated
// row of the bound's date, falls on the wrong side of a plain
// `recorded_at >= ?` (with month windows, out of both windows). So a row's
// instant is read here, the same way for every shape: a zone-less value is
// UTC (as SQLite and the cloud read it), digits below the millisecond are
// dropped (as Date.parse and the sync hash do).
const ZONELESS_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

function parseRecordedAtMs(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const zoneless = ZONELESS_TIMESTAMP.exec(text);
  const ms = Date.parse(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : text);
  return Number.isFinite(ms) ? ms : null;
}

// The ISO UTC form of a stored recorded_at, for output (CSV, raw series).
// Unchanged for a toISOString value; an unreadable value is passed through.
function canonicalRecordedAt(value) {
  const ms = parseRecordedAtMs(value);
  return ms === null ? value : new Date(ms).toISOString();
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SQLITE_UTC_MS_FORMAT = '%Y-%m-%dT%H:%M:%fZ';

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// A WHERE fragment selecting the rows of `column` whose instant may lie in
// [start, end) (or [start, end] with endInclusive). It is a superset by at
// most a millisecond at each end (SQLite rounds the sub-millisecond digits
// that parseRecordedAtMs drops), so callers that need the exact range filter
// the rows with recordedAtRangeFilter. The first pair of bounds is plain text on
// whole dates, wide enough for any shape and offset (a stored date can be a
// day off the UTC date), so the (deveui, recorded_at) index still bounds the
// scan; strftime then reads each candidate's instant. With `exact`, the
// SQLite instant is the final filter (for SQL-side aggregates).
function recordedAtRangeSql(column, start, end, options = {}) {
  const startMs = parseTime(start);
  const endMs = parseTime(end);
  const upper = options.endInclusive ? '<=' : '<';
  if (startMs === null || endMs === null) {
    return { sql: `${column} >= ? AND ${column} ${upper} ?`, params: [start, end] };
  }
  const instant = `strftime('${SQLITE_UTC_MS_FORMAT}', ${column})`;
  const marginMs = options.exact ? 0 : 1;
  return {
    sql: `${column} >= ? AND ${column} < ? AND ${instant} >= ? AND ${instant} ${options.exact ? upper : '<='} ?`,
    params: [
      isoDate(startMs - DAY_MS),
      isoDate(endMs + 2 * DAY_MS),
      new Date(startMs - marginMs).toISOString(),
      new Date(endMs + marginMs).toISOString(),
    ],
  };
}

// The exact [start, end) filter on a row's instant, for rows selected with
// recordedAtRangeSql.
function recordedAtRangeFilter(start, end) {
  const startMs = parseTime(start);
  const endMs = parseTime(end);
  return (row) => {
    const ms = parseRecordedAtMs(row.recorded_at);
    return ms !== null && (startMs === null || ms >= startMs) && (endMs === null || ms < endMs);
  };
}

function sortByRecordedAt(rows) {
  return rows
    .map((row, index) => ({ row, index, ms: parseRecordedAtMs(row.recorded_at) }))
    .sort((left, right) => (left.ms - right.ms) || (left.index - right.index))
    .map((entry) => entry.row);
}

function normalizeDeveui(value) {
  const normalized = String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return /^[0-9A-F]{16}$/.test(normalized) ? normalized : null;
}

function normalizeCardType(value) {
  const cardType = String(value || '').trim().toLowerCase();
  return cardType === 'env' ? 'environment' : cardType;
}

function dendroSourceKey(deveui) {
  const normalized = normalizeDeveui(deveui);
  if (!normalized) return null;
  return `dendro-src-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

function displaySafeSourceKey(cardType, device) {
  const normalized = normalizeDeveui(device && (device.deveui || device.device_eui));
  if (!normalized) return null;
  const prefix = normalizeCardType(cardType) || 'source';
  return `${prefix}-src-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

function displayDeviceName(device, index) {
  const name = String(device && device.name || '').trim();
  if (name && !/\b[0-9a-fA-F]{16}\b/.test(name)) return name;
  const typeId = String(device && device.type_id || '').trim();
  if (typeId) return typeId.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, function(char) { return char.toUpperCase(); });
  return 'Source ' + String(index + 1);
}

function displaySourceDevices(cardType, devices) {
  return (devices || [])
    .slice()
    .sort((left, right) =>
      String(normalizeDeveui(left.deveui || left.device_eui) || '').localeCompare(String(normalizeDeveui(right.deveui || right.device_eui) || ''))
    )
    .map((device, index) => ({
      name: displayDeviceName(device, index),
      typeId: String(device && device.type_id || '').trim() || null,
      role: normalizeCardType(cardType) || null,
      sourceKey: displaySafeSourceKey(cardType, device),
    }))
    .filter((device) => device.sourceKey);
}

function deriveCardId(options, cardTypeArg, logicalSourceKeyArg) {
  const input = typeof options === 'object' && options !== null
    ? options
    : { zoneUuid: options, cardType: cardTypeArg, logicalSourceKey: logicalSourceKeyArg };
  const cardType = normalizeCardType(input.cardType || input.type);

  if (cardType === 'gateway') {
    const gatewayEui = normalizeDeveui(input.gatewayEui || input.gateway_eui || input.deveui || input.zoneUuid);
    if (!gatewayEui) return null;
    return `${gatewayEui}:gateway:hub`;
  }

  const zoneUuid = String(input.zoneUuid || input.zone_uuid || '').trim();
  if (!zoneUuid || !cardType) return null;

  let logicalSourceKey = input.logicalSourceKey || input.logical_source_key || DEFAULT_SOURCE_KEYS[cardType];
  if (cardType === 'dendro') {
    logicalSourceKey = input.logicalSourceKey || input.logical_source_key || dendroSourceKey(input.deveui || input.device_eui);
  }
  if (!logicalSourceKey) return null;
  return `${zoneUuid}:${cardType}:${logicalSourceKey}`;
}

function hasNumber(device, keys) {
  return keys.some((key) => toFiniteNumber(device && device[key]) !== null);
}

const DEVICE_FLAG_ALIASES = {
  chameleon_enabled: ['chameleonEnabled'],
  dendro_enabled: ['dendroEnabled'],
  temp_enabled: ['tempEnabled'],
  rain_gauge_enabled: ['rainGaugeEnabled'],
  flow_meter_enabled: ['flowMeterEnabled'],
};

function hasOwn(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function flagEnabled(device, canonical) {
  if (!device) return false;
  const aliases = DEVICE_FLAG_ALIASES[canonical] || [];
  let raw;
  if (hasOwn(device, canonical)) raw = device[canonical];
  else {
    const alias = aliases.find((key) => hasOwn(device, key));
    raw = alias ? device[alias] : undefined;
  }
  if (raw === true) return true;
  if (raw === false || raw === null || raw === undefined || raw === '') return false;
  return Number(raw) === 1 || String(raw).trim().toLowerCase() === 'true';
}

function isChameleonDevice(device) {
  return flagEnabled(device, 'chameleon_enabled');
}

function deviceTypeId(device) {
  if (hasOwn(device, 'type_id')) return String(device.type_id || '').trim().toUpperCase();
  if (hasOwn(device, 'typeId')) return String(device.typeId || '').trim().toUpperCase();
  return String(device && device.type || '').trim().toUpperCase();
}

function isLsn50Swt3Eligible(device) {
  const type = deviceTypeId(device);
  return type !== 'DRAGINO_LSN50' || isChameleonDevice(device);
}

function filterSoilChannelsForSources(channels, sourceDevices) {
  const normalized = normalizeChannels(channels);
  const devices = Array.isArray(sourceDevices) ? sourceDevices : [];
  if (!devices.length) return normalized;
  return devices.some(isLsn50Swt3Eligible)
    ? normalized
    : normalized.filter((channel) => channel.id !== 'swt_3');
}

function filterSoilRowsForSources(rows, sourceDevices) {
  const devices = Array.isArray(sourceDevices) ? sourceDevices : [];
  if (!devices.length) return Array.isArray(rows) ? rows : [];
  const byEui = new Map();
  for (const device of devices) {
    const eui = normalizeDeveui(device && (device.deveui || device.device_eui || device.deviceEui));
    if (eui) byEui.set(eui, device);
  }
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const eui = normalizeDeveui(row && (row.deveui || row.device_eui || row.deviceEui));
    const device = eui ? byEui.get(eui) : null;
    if (!device || isLsn50Swt3Eligible(device)) return row;
    return { ...row, swt_3: null };
  });
}

function deviceBelongsToZone(device, zone) {
  if (!device || !zone) return false;
  const zoneId = toFiniteNumber(zone.id ?? zone.zone_id);
  const deviceZoneId = toFiniteNumber(device.irrigation_zone_id || device.zone_id);
  if (zoneId !== null) return deviceZoneId === zoneId;
  const zoneUuid = String(zone.zone_uuid || zone.zoneUuid || '').trim();
  const deviceZoneUuid = String(device.irrigation_zone_uuid || device.zone_uuid || device.zoneUuid || '').trim();
  return !!zoneUuid && !!deviceZoneUuid && zoneUuid === deviceZoneUuid;
}

// A WATERMARK node is a DRAGINO_LSN50 with positive WATERMARK evidence: a
// retained (not deleted) watermark_calibrations row or at least one
// watermark_readings row. The device row carries that evidence as
// watermark_evidence, set by annotateWatermarkEvidence where the rows are
// loaded; a row without it is not a WATERMARK node.
function isWatermarkNode(device) {
  return deviceTypeId(device) === 'DRAGINO_LSN50' && flagEnabled(device, 'watermark_evidence');
}

// An LSN50 is a soil source when it is a Chameleon device, or a WATERMARK node,
// or none of dendro/temp/rain/flow is set. A WATERMARK frame always carries a
// temperature, so temp_enabled does not hide its SWT1/SWT2; dendro, rain gauge
// and flow meter use the same inputs and still exclude it.
function isSoilSource(device) {
  const type = deviceTypeId(device);
  if (type === 'DRAGINO_LSN50') {
    if (isChameleonDevice(device)) return true;
    if (['dendro_enabled', 'rain_gauge_enabled', 'flow_meter_enabled'].some((flag) => flagEnabled(device, flag))) {
      return false;
    }
    return isWatermarkNode(device) || !flagEnabled(device, 'temp_enabled');
  }
  return ['KIWI_SENSOR', 'TEKTELIC_CLOVER', 'DRAGINO_SDI12'].includes(type)
    || isChameleonDevice(device)
    || hasNumber(device, ['swt_1', 'swt_2', 'swt_3', 'swt_wm1', 'swt_wm2']);
}

// Adds watermark_evidence (1 or 0) to every DRAGINO_LSN50 row, with one query
// for the whole list. Other rows are returned unchanged.
async function annotateWatermarkEvidence(db, devices) {
  const rows = Array.isArray(devices) ? devices : [];
  const lsn50Euis = Array.from(new Set(rows
    .filter((device) => deviceTypeId(device) === 'DRAGINO_LSN50')
    .map((device) => normalizeDeveui(device && (device.deveui || device.device_eui || device.deviceEui)))
    .filter(Boolean)));
  if (!lsn50Euis.length) return rows;
  const found = await dbAll(db,
    'WITH ids(eui) AS (VALUES ' + lsn50Euis.map(() => '(?)').join(',') + ') ' +
    'SELECT eui FROM ids WHERE EXISTS (SELECT 1 FROM watermark_calibrations c WHERE c.deveui = ids.eui AND c.deleted_at IS NULL) ' +
    'OR EXISTS (SELECT 1 FROM watermark_readings r WHERE r.deveui = ids.eui)',
    lsn50Euis);
  const evidence = new Set(found.map((row) => normalizeDeveui(row && row.eui)).filter(Boolean));
  return rows.map((device) => {
    if (deviceTypeId(device) !== 'DRAGINO_LSN50') return device;
    const eui = normalizeDeveui(device && (device.deveui || device.device_eui || device.deviceEui));
    return { ...device, watermark_evidence: eui && evidence.has(eui) ? 1 : 0 };
  });
}

const ENVIRONMENT_SOURCE_TYPES = new Set([
  'KIWI_SENSOR',
  'TEKTELIC_CLOVER',
  'SENSECAP_S2120',
  'AQUASCOPE_LORAIN',
]);

function isEnvironmentSource(device, options = {}) {
  const type = deviceTypeId(device);
  return ENVIRONMENT_SOURCE_TYPES.has(type)
    || (type === 'DRAGINO_LSN50' && Number(device && device.temp_enabled || 0) === 1)
    || (options.allowMeasurementFallback !== false
      && hasNumber(device, ['ambient_temperature', 'relative_humidity', 'ext_temperature_c', 'light_lux', 'rain_mm_today']));
}

function isIrrigationSource(device) {
  return String(device && device.type_id || '').toUpperCase() === 'STREGA_VALVE';
}

function isDendroSource(device) {
  return String(device && device.type_id || '').toUpperCase() === 'DRAGINO_LSN50'
    && Number(device && device.dendro_enabled || 0) === 1;
}

function uniqueDeveuis(devices) {
  return Array.from(new Set((Array.isArray(devices) ? devices : [])
    .map((device) => normalizeDeveui(device && (device.deveui || device.device_eui || device.deviceEui)))
    .filter(Boolean)));
}

function sourceDevicesForCard(card, devices) {
  const cardType = normalizeCardType(card && card.cardType);
  const rows = Array.isArray(devices) ? devices : [];
  if (cardType === 'soil') return rows.filter(isSoilSource);
  if (cardType === 'environment') return rows.filter(isEnvironmentSource);
  if (cardType === 'irrigation') return rows.filter(isIrrigationSource);
  if (cardType === 'dendro') {
    const sourceKey = String(card && card.logicalSourceKey || '').trim();
    return rows.filter((device) => isDendroSource(device) && dendroSourceKey(device.deveui || device.device_eui) === sourceKey);
  }
  return [];
}

function channelsForCard(card, sourceDevices) {
  const cardType = normalizeCardType(card && card.cardType);
  if (cardType === 'soil') {
    const channels = [
      { id: 'swt_1', field: 'swt_1', fields: ['swt_1', 'swt_wm1'], unit: 'kPa', label: 'Soil tension (S1)' },
      { id: 'swt_2', field: 'swt_2', fields: ['swt_2', 'swt_wm2'], unit: 'kPa', label: 'Soil tension (S2)' },
      { id: 'swt_3', field: 'swt_3', unit: 'kPa', label: 'Soil tension (S3)' },
      { id: 'vwc_1', field: 'vwc_1', unit: '%', label: 'VWC 1' },
      { id: 'vwc_2', field: 'vwc_2', unit: '%', label: 'VWC 2' },
      { id: 'vwc_3', field: 'vwc_3', unit: '%', label: 'VWC 3' },
      { id: 'vwc_4', field: 'vwc_4', unit: '%', label: 'VWC 4' },
      { id: 'vwc_5', field: 'vwc_5', unit: '%', label: 'VWC 5' },
      { id: 'vwc_6', field: 'vwc_6', unit: '%', label: 'VWC 6' },
      { id: 'vwc_7', field: 'vwc_7', unit: '%', label: 'VWC 7' },
      { id: 'vwc_8', field: 'vwc_8', unit: '%', label: 'VWC 8' },
      { id: 'vwc_9', field: 'vwc_9', unit: '%', label: 'VWC 9' },
      { id: 'vwc_10', field: 'vwc_10', unit: '%', label: 'VWC 10' },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `soil_vic_${i + 1}`, field: `soil_vic_${i + 1}`, unit: '', label: `VIC ${i + 1}` })),
      { id: 'soil_temp_1', field: 'soil_temp_1', unit: '°C', label: 'Soil temp 1' },
      { id: 'soil_temp_2', field: 'soil_temp_2', unit: '°C', label: 'Soil temp 2' },
      { id: 'soil_temp_3', field: 'soil_temp_3', unit: '°C', label: 'Soil temp 3' },
      { id: 'soil_temp_4', field: 'soil_temp_4', unit: '°C', label: 'Soil temp 4' },
      { id: 'soil_temp_5', field: 'soil_temp_5', unit: '°C', label: 'Soil temp 5' },
      { id: 'soil_temp_6', field: 'soil_temp_6', unit: '°C', label: 'Soil temp 6' },
      { id: 'soil_temp_7', field: 'soil_temp_7', unit: '°C', label: 'Soil temp 7' },
      { id: 'soil_temp_8', field: 'soil_temp_8', unit: '°C', label: 'Soil temp 8' },
      { id: 'soil_ec_1', field: 'soil_ec_1', unit: 'µS/cm', label: 'Soil EC 1' },
      { id: 'soil_ec_2', field: 'soil_ec_2', unit: 'µS/cm', label: 'Soil EC 2' },
      { id: 'soil_ec_3', field: 'soil_ec_3', unit: 'µS/cm', label: 'Soil EC 3' },
      { id: 'soil_ec_4', field: 'soil_ec_4', unit: 'µS/cm', label: 'Soil EC 4' },
      { id: 'soil_ec_5', field: 'soil_ec_5', unit: 'µS/cm', label: 'Soil EC 5' },
      { id: 'soil_ec_6', field: 'soil_ec_6', unit: 'µS/cm', label: 'Soil EC 6' },
      { id: 'soil_ec_7', field: 'soil_ec_7', unit: 'µS/cm', label: 'Soil EC 7' },
      { id: 'soil_ec_8', field: 'soil_ec_8', unit: 'µS/cm', label: 'Soil EC 8' },
    ];
    return filterSoilChannelsForSources(channels, sourceDevices);
  }
  if (cardType === 'environment') {
    return [
      { id: 'ambient_temperature', field: 'ambient_temperature', unit: '°C', label: 'Ambient temperature' },
      { id: 'relative_humidity', field: 'relative_humidity', unit: '%', label: 'Relative humidity' },
      { id: 'ext_temperature_c', field: 'ext_temperature_c', unit: '°C', label: 'External temperature' },
      { id: 'light_lux', field: 'light_lux', unit: 'lux', label: 'Light' },
      { id: 'rain_mm_per_hour', field: 'rain_mm_per_hour', unit: 'mm/h', label: 'Rain rate' },
      { id: 'rain_mm_per_10min', field: 'rain_mm_per_10min', unit: 'mm/10min', label: 'Rain (10 min)' },
      { id: 'rain_mm_today', field: 'rain_mm_today', unit: 'mm', label: 'Rain today' },
      { id: 'rain_mm_delta', field: 'rain_mm_delta', unit: 'mm', label: 'Rain delta' },
      { id: 'wind_speed_mps', field: 'wind_speed_mps', unit: 'm/s', label: 'Wind speed' },
      { id: 'wind_gust_mps', field: 'wind_gust_mps', unit: 'm/s', label: 'Wind gust' },
      { id: 'barometric_pressure_hpa', field: 'barometric_pressure_hpa', unit: 'hPa', label: 'Pressure' },
      { id: 'uv_index', field: 'uv_index', unit: null, label: 'UV index' },
      { id: 'rain_tips_delta', field: 'rain_tips_delta', unit: 'count', label: 'Rain tips delta' },
    ];
  }
  if (cardType === 'dendro') {
    return [
      { id: 'dendro_stem_change_um', field: 'dendro_stem_change_um', unit: 'µm', label: 'Stem change' },
      { id: 'dendro_position_mm', field: 'dendro_position_mm', unit: 'mm', label: 'Position' },
      { id: 'dendro_position_raw_mm', field: 'dendro_position_raw_mm', unit: 'mm', label: 'Position (raw)' },
      { id: 'dendro_delta_mm', field: 'dendro_delta_mm', unit: 'mm', label: 'Delta' },
      { id: 'dendro_ratio', field: 'dendro_ratio', unit: null, label: 'Ratio' },
      { id: 'adc_ch0v', field: 'adc_ch0v', unit: 'V', label: 'ADC ch0' },
      { id: 'adc_ch1v', field: 'adc_ch1v', unit: 'V', label: 'ADC ch1' },
    ];
  }
  return [];
}

function deriveCardsForZone(zone, devices) {
  const zoneUuid = String(zone && (zone.zone_uuid || zone.zoneUuid) || '').trim();
  if (!zoneUuid) return [];
  const scopedDevices = (Array.isArray(devices) ? devices : []).filter((device) => deviceBelongsToZone(device, zone));
  const cards = [];

  const pushMerged = (cardType, predicate) => {
    const sourceDevices = displaySourceDevices(cardType, scopedDevices.filter(predicate));
    const count = sourceDevices.length;
    if (count > 0) {
      cards.push({
        id: deriveCardId({ zoneUuid, cardType }),
        cardType,
        logicalSourceKey: DEFAULT_SOURCE_KEYS[cardType],
        sourceDeviceCount: count,
        sourceDevices,
      });
    }
  };

  pushMerged('soil', isSoilSource);
  for (const device of scopedDevices.filter(isDendroSource).slice().sort((left, right) =>
    String(normalizeDeveui(left.deveui || left.device_eui) || '').localeCompare(String(normalizeDeveui(right.deveui || right.device_eui) || ''))
  )) {
    const logicalSourceKey = dendroSourceKey(device.deveui || device.device_eui);
    if (logicalSourceKey) {
      cards.push({
        id: deriveCardId({ zoneUuid, cardType: 'dendro', logicalSourceKey }),
        cardType: 'dendro',
        logicalSourceKey,
        sourceDeviceCount: 1,
      });
    }
  }
  pushMerged('environment', isEnvironmentSource);
  pushMerged('irrigation', isIrrigationSource);

  return cards;
}

function deriveGatewayCard(gatewayEui) {
  const normalized = normalizeDeveui(gatewayEui);
  if (!normalized) return null;
  return {
    id: `${normalized}:gateway:hub`,
    cardType: 'gateway',
    logicalSourceKey: 'hub',
    gatewayEui: normalized,
  };
}

function firstFinite(input, keys) {
  for (const key of keys) {
    const number = toFiniteNumber(input && input[key]);
    if (number !== null) return number;
  }
  return null;
}

function meanFinite(values) {
  const finite = values.map(toFiniteNumber).filter((value) => value !== null);
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function classifySoilStatus(input = {}) {
  const thresholds = input.thresholds || {};
  const wetKpa = toFiniteNumber(thresholds.wetKpa) ?? 22;
  const dryKpa = toFiniteNumber(thresholds.dryKpa) ?? 50;
  const value = firstFinite(input, ['swtKpa', 'swt_kpa', 'value'])
    ?? meanFinite([input.swt_1, input.swt_2, input.swt_3, input.swt_wm1, input.swt_wm2]);

  if (value === null) return { status: 'no_data', severity: 'info', value: null };
  if (value > dryKpa) return { status: 'dry_stress', severity: 'warning', value: roundTo(value), thresholds: { wetKpa, dryKpa } };
  if (value < wetKpa) return { status: 'wet_excess', severity: 'warning', value: roundTo(value), thresholds: { wetKpa, dryKpa } };
  return { status: 'optimal', severity: 'normal', value: roundTo(value), thresholds: { wetKpa, dryKpa } };
}

function classifyEnvironmentStatus(input = {}) {
  const thresholds = input.thresholds || {};
  const heatStressC = toFiniteNumber(thresholds.heatStressC) ?? 35;
  const coldStressC = toFiniteNumber(thresholds.coldStressC) ?? 5;
  const highHumidityPct = toFiniteNumber(thresholds.highHumidityPct) ?? 90;
  const rainDayMm = toFiniteNumber(thresholds.rainDayMm) ?? 1;
  const temperature = firstFinite(input, ['ambientTemperature', 'ambient_temperature', 'ext_temperature_c', 'temperatureC', 'value']);
  const humidity = firstFinite(input, ['relativeHumidity', 'relative_humidity']);
  const rain = firstFinite(input, ['rainMm', 'rain_mm_today', 'rain_mm_delta', 'rain_mm_per_hour']);

  if (temperature !== null && temperature >= heatStressC) return { status: 'heat_stress', severity: 'warning', value: roundTo(temperature), channel: 'temperature' };
  if (temperature !== null && temperature <= coldStressC) return { status: 'cold_stress', severity: 'warning', value: roundTo(temperature), channel: 'temperature' };
  if (humidity !== null && humidity >= highHumidityPct) return { status: 'high_humidity', severity: 'info', value: roundTo(humidity), channel: 'humidity' };
  if (rain !== null && rain >= rainDayMm) return { status: 'rain_day', severity: 'info', value: roundTo(rain), channel: 'rain' };
  if (temperature === null && humidity === null && rain === null) return { status: 'no_data', severity: 'info', value: null };
  return { status: 'normal', severity: 'normal', value: roundTo(temperature ?? humidity ?? rain) };
}

function classifyDendroStatus(input = {}) {
  const thresholds = input.thresholds || {};
  const recoveryRatioMin = toFiniteNumber(thresholds.recoveryRatioMin) ?? 0.5;
  const highShrinkageUm = toFiniteNumber(thresholds.highShrinkageUm) ?? 400;
  const recoveryRatio = firstFinite(input, ['recoveryRatio', 'recovery_ratio']);
  const mdsUm = firstFinite(input, ['mdsUm', 'mds_um', 'twdUm', 'twd_um']);
  const growthUm = firstFinite(input, ['growthUm', 'growth_um', 'tgrUm', 'tgr_um']);

  if (recoveryRatio !== null && recoveryRatio < recoveryRatioMin) {
    return { status: 'incomplete_night_recovery', severity: 'warning', value: roundTo(recoveryRatio) };
  }
  if (mdsUm !== null && mdsUm >= highShrinkageUm) {
    return { status: 'high_shrinkage_stress', severity: 'warning', value: roundTo(mdsUm) };
  }
  if (growthUm !== null && growthUm <= 0) {
    return { status: 'reduced_growth', severity: 'info', value: roundTo(growthUm) };
  }
  if (recoveryRatio === null && mdsUm === null && growthUm === null) {
    return { status: 'no_data', severity: 'info', value: null };
  }
  return { status: 'normal_growth', severity: 'normal', value: roundTo(growthUm ?? mdsUm ?? recoveryRatio) };
}

function classifyIrrigationStatus(input = {}) {
  if (input.manualOverride === true || input.manual_override === true) {
    return { status: 'manual_override', severity: 'info' };
  }
  if (input.possibleIneffectiveIrrigation === true || input.possible_ineffective_irrigation === true) {
    return { status: 'possible_ineffective_irrigation', severity: 'warning' };
  }
  const eventCount = firstFinite(input, ['eventCount', 'event_count', 'irrigationEventCount', 'irrigation_event_count']);
  if (eventCount === null) return { status: 'no_data', severity: 'info', eventCount: null };
  const highFrequencyThreshold = toFiniteNumber(input.highFrequencyThreshold ?? input.high_frequency_threshold) ?? 3;
  if (eventCount >= highFrequencyThreshold) {
    return { status: 'high_irrigation_frequency', severity: 'warning', eventCount: Math.round(eventCount) };
  }
  if (eventCount > 0) return { status: 'irrigation_event', severity: 'info', eventCount: Math.round(eventCount) };
  return { status: 'no_irrigation', severity: 'normal', eventCount: 0 };
}

function classifyGatewayStatus(input = {}) {
  const generatedAt = parseTime(input.generatedAt || input.generated_at) ?? Date.now();
  const lastSeenAt = parseTime(input.lastSeenAt || input.last_seen_at || input.recorded_at);
  if (lastSeenAt === null) return { status: 'no_data', severity: 'info', lastSeenAt: null };
  const offlineAfterSeconds = toFiniteNumber(input.offlineAfterSeconds ?? input.offline_after_seconds) ?? (10 * 60);
  const ageSeconds = Math.max(0, Math.round((generatedAt - lastSeenAt) / 1000));
  if (ageSeconds > offlineAfterSeconds) {
    return { status: 'offline', severity: 'warning', lastSeenAt: new Date(lastSeenAt).toISOString(), ageSeconds };
  }
  return { status: 'normal', severity: 'normal', lastSeenAt: new Date(lastSeenAt).toISOString(), ageSeconds };
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function durationSecondsBetween(start, end) {
  const startMs = parseTime(start);
  const endMs = parseTime(end);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return (endMs - startMs) / 1000;
}

function cadenceReferenceMs(options = {}, times = []) {
  const explicit = parseTime(options.end || options.endAt || options.to || options.referenceAt || options.reference_at);
  if (explicit !== null) return explicit;
  return times.length ? Math.max(...times) : null;
}

function cadenceWindowTimes(times, referenceMs) {
  if (referenceMs === null) return times;
  const startMs = referenceMs - CADENCE_LOOKBACK_MS;
  return times.filter((time) => time >= startMs && time <= referenceMs);
}

function resolveAggregation(options = {}) {
  const requested = String(options.aggregation || 'auto').trim().toLowerCase();
  if (requested !== 'auto') {
    if (!ALLOWED_AGGREGATIONS.has(requested)) throw new Error(`unsupported aggregation: ${requested}`);
    return {
      requested,
      level: requested,
      bucketSizeSeconds: requested === 'raw' ? null : BUCKET_SECONDS[requested],
    };
  }

  const range = String(options.range || options.rangeLabel || options.range_label || '').trim().toLowerCase();
  const durationSeconds = durationSecondsBetween(options.start || options.startAt || options.from, options.end || options.endAt || options.to);
  let level = 'raw';
  if (range === '7d') {
    level = 'hourly';
  } else if (range === '30d') {
    level = 'daily';
  } else if (range === 'season') {
    level = durationSeconds !== null && durationSeconds > (120 * 24 * 60 * 60) ? 'weekly' : 'daily';
  } else if (durationSeconds !== null) {
    if (durationSeconds <= 24 * 60 * 60) level = 'raw';
    else if (durationSeconds <= 48 * 60 * 60) level = '15m';
    else if (durationSeconds <= 8 * 24 * 60 * 60) level = 'hourly';
    else if (durationSeconds <= 120 * 24 * 60 * 60) level = 'daily';
    else level = 'weekly';
  }

  return {
    requested: 'auto',
    level,
    bucketSizeSeconds: level === 'raw' ? null : BUCKET_SECONDS[level],
  };
}

function deriveExpectedCadenceSeconds(options = {}) {
  const configured = toFiniteNumber(options.configuredCadenceSeconds ?? options.configured_cadence_seconds);
  if (configured !== null && configured > 0) return { seconds: Math.round(configured), confidence: 'configured' };

  const rows = Array.isArray(options.rows) ? options.rows : [];
  const times = rows
    .map((row) => parseTime(row.recorded_at || row.recordedAt || row.bucket_start))
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const derived = cadenceFromTimes(times, cadenceReferenceMs(options, times));
  return derived !== null
    ? { seconds: derived, confidence: 'derived' }
    : { seconds: null, confidence: 'unknown' };
}

function normalizeChannels(channels) {
  return (Array.isArray(channels) ? channels : [])
    .map((channel) => {
      if (typeof channel === 'string') return { id: channel, field: channel, fields: [channel] };
      if (!channel || typeof channel !== 'object') return null;
      const field = channel.field || channel.id;
      return {
        id: channel.id || field,
        field,
        fields: Array.isArray(channel.fields) && channel.fields.length ? channel.fields : [field],
        unit: channel.unit || null,
        label: channel.label || null,
      };
    })
    .filter((channel) => channel && channel.id && channel.field);
}

function channelFieldNames(channel) {
  return Array.from(new Set((Array.isArray(channel && channel.fields) && channel.fields.length ? channel.fields : [channel && channel.field])
    .filter(Boolean)));
}

function channelValue(row, channel) {
  for (const field of channelFieldNames(channel)) {
    const value = toFiniteNumber(row && row[field]);
    if (value !== null) return value;
  }
  return null;
}

function bucketStartFor(ms, startMs, bucketSeconds) {
  const bucketMs = bucketSeconds * 1000;
  const offset = Math.floor((ms - startMs) / bucketMs) * bucketMs;
  return startMs + Math.max(0, offset);
}

function statsForValues(values) {
  const numeric = values
    .map((entry) => ({ value: toFiniteNumber(entry.value), recordedAtMs: entry.recordedAtMs }))
    .filter((entry) => entry.value !== null)
    .sort((a, b) => a.recordedAtMs - b.recordedAtMs);
  if (numeric.length === 0) return null;
  const onlyValues = numeric.map((entry) => entry.value);
  const sum = onlyValues.reduce((total, value) => total + value, 0);
  return {
    min: roundTo(Math.min(...onlyValues)),
    max: roundTo(Math.max(...onlyValues)),
    mean: roundTo(sum / onlyValues.length),
    median: roundTo(median(onlyValues)),
    latest: roundTo(numeric[numeric.length - 1].value),
    sampleCount: numeric.length,
    sum: roundTo(sum),
  };
}

function rowSourceKey(row, channel) {
  const raw = row.sourceKey
    || row.source_key
    || row.seriesId
    || row.series_id
    || row.cardSourceId
    || row.card_source_id
    || row.logicalSourceKey
    || row.logical_source_key
    || row.deveui
    || row.device_eui
    || row.deviceEui
    || channel.sourceKey
    || channel.source_key
    || 'default';
  return normalizeDeveui(raw) || String(raw || 'default').trim() || 'default';
}

function sourceChannelKey(sourceKey, channel) {
  return `${sourceKey}|${channel.id}`;
}

function sourceSupportsChannel(sourceKey, channel, options = {}) {
  if (!channel || channel.id !== 'swt_3' || !Array.isArray(options.sourceDevices) || !options.sourceDevices.length) return true;
  const normalized = normalizeDeveui(sourceKey);
  const source = options.sourceDevices.find((device) => normalizeDeveui(device && (device.deveui || device.device_eui || device.deviceEui)) === normalized);
  return !source || isLsn50Swt3Eligible(source);
}

function normalizeSourceKey(value) {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'object'
    ? (value.sourceKey
      || value.source_key
      || value.seriesId
      || value.series_id
      || value.cardSourceId
      || value.card_source_id
      || value.logicalSourceKey
      || value.logical_source_key
      || value.deveui
      || value.device_eui
      || value.deviceEui
      || value.id)
    : value;
  if (raw === null || raw === undefined) return null;
  const normalized = normalizeDeveui(raw) || String(raw).trim();
  return normalized || null;
}

function requestedSourceKeys(options = {}) {
  const lists = [
    options.sourceKeys,
    options.source_keys,
    options.requestedSourceKeys,
    options.requested_source_keys,
    options.requestedSources,
    options.requested_sources,
    options.deveuis,
    options.deviceEuis,
    options.device_euis,
    options.sourceDevices,
    options.source_devices,
  ].filter(Array.isArray);
  const keys = [];
  const seen = new Set();
  for (const list of lists) {
    for (const item of list) {
      const key = normalizeSourceKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function addSourceChannelSample(samples, sourceKey, channel) {
  const key = sourceChannelKey(sourceKey, channel);
  if (!samples.has(key)) {
    samples.set(key, {
      key,
      sourceKey,
      channelId: channel.id,
      channelField: channel.field,
      times: [],
    });
  }
}

function normalizeCadenceMapKey(rawKey) {
  const key = String(rawKey || '').trim();
  const separatorIndex = key.indexOf('|');
  if (separatorIndex > 0) {
    const sourceKey = normalizeSourceKey(key.slice(0, separatorIndex)) || key.slice(0, separatorIndex).trim();
    const channelKey = key.slice(separatorIndex + 1).trim();
    return sourceKey && channelKey ? `${sourceKey}|${channelKey}` : key;
  }
  return normalizeSourceKey(key) || key;
}

function configuredCadenceFor(options, sourceKey, channel, key) {
  const maps = [
    options.expectedCadences,
    options.expectedCadenceBySource,
    options.expectedCadenceSecondsBySource,
    options.expected_cadences,
    options.expected_cadence_by_source,
    options.expected_cadence_seconds_by_source,
  ].filter((value) => value && typeof value === 'object');
  const candidates = new Set([key, `${sourceKey}|${channel.field}`, sourceKey, channel.id, channel.field]);
  for (const map of maps) {
    for (const rawKey of Object.keys(map)) {
      if (candidates.has(rawKey) || candidates.has(normalizeCadenceMapKey(rawKey))) {
        const value = map[rawKey];
        const seconds = toFiniteNumber(value && typeof value === 'object' ? value.seconds : value);
        if (seconds !== null && seconds > 0) return Math.round(seconds);
      }
    }
  }
  const fallback = toFiniteNumber(
    options.expectedCadenceSeconds
    ?? options.expected_cadence_seconds
    ?? options.configuredCadenceSeconds
    ?? options.configured_cadence_seconds
  );
  return fallback !== null && fallback > 0 ? Math.round(fallback) : null;
}

function seedConfiguredSourceChannelSamples(samples, channels, options = {}) {
  const fullKeyMaps = [
    options.expectedCadences,
    options.expected_cadences,
  ].filter((value) => value && typeof value === 'object');
  for (const map of fullKeyMaps) {
    for (const rawKey of Object.keys(map)) {
      const separatorIndex = rawKey.indexOf('|');
      if (separatorIndex <= 0) continue;
      const sourceKey = normalizeSourceKey(rawKey.slice(0, separatorIndex));
      const channelKey = rawKey.slice(separatorIndex + 1);
      const channel = channels.find((candidate) => candidate.id === channelKey || candidate.field === channelKey);
      if (sourceKey && channel && sourceSupportsChannel(sourceKey, channel, options)) addSourceChannelSample(samples, sourceKey, channel);
    }
  }

  const sourceMaps = [
    options.expectedCadenceBySource,
    options.expectedCadenceSecondsBySource,
    options.expected_cadence_by_source,
    options.expected_cadence_seconds_by_source,
  ].filter((value) => value && typeof value === 'object');
  for (const map of sourceMaps) {
    for (const rawKey of Object.keys(map)) {
      const sourceKey = normalizeSourceKey(rawKey);
      if (!sourceKey) continue;
      for (const channel of channels) {
        if (sourceSupportsChannel(sourceKey, channel, options)) addSourceChannelSample(samples, sourceKey, channel);
      }
    }
  }
}

function seedRequestedSourceChannelSamples(samples, channels, options = {}) {
  for (const sourceKey of requestedSourceKeys(options)) {
    for (const channel of channels) {
      if (sourceSupportsChannel(sourceKey, channel, options)) addSourceChannelSample(samples, sourceKey, channel);
    }
  }
}

function sourceChannelSamples(sortedRows, channels) {
  const samples = new Map();
  for (const entry of sortedRows) {
    for (const channel of channels) {
      if (channelValue(entry.row, channel) === null) continue;
      const sourceKey = rowSourceKey(entry.row, channel);
      const key = sourceChannelKey(sourceKey, channel);
      if (!samples.has(key)) {
        samples.set(key, {
          key,
          sourceKey,
          channelId: channel.id,
          channelField: channel.field,
          times: [],
        });
      }
      samples.get(key).times.push(entry.recordedAtMs);
    }
  }
  return samples;
}

function cadenceFromTimes(times, referenceMs = null) {
  const sorted = cadenceWindowTimes(times.slice().sort((a, b) => a - b), referenceMs);
  const deltas = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const deltaSeconds = (sorted[index] - sorted[index - 1]) / 1000;
    if (deltaSeconds > 0) deltas.push(deltaSeconds);
  }
  const medianDelta = median(deltas);
  return medianDelta !== null && medianDelta > 0 ? Math.round(medianDelta) : null;
}

function deriveSourceCadences(sortedRows, channels, options = {}, allowDerived = true) {
  const samples = sourceChannelSamples(sortedRows, channels);
  seedConfiguredSourceChannelSamples(samples, channels, options);
  seedRequestedSourceChannelSamples(samples, channels, options);
  const referenceMs = cadenceReferenceMs(options, sortedRows.map((entry) => entry.recordedAtMs));
  const cadences = {};
  for (const sample of samples.values()) {
    const channel = channels.find((candidate) => candidate.id === sample.channelId) || { id: sample.channelId, field: sample.channelField };
    const configured = configuredCadenceFor(options, sample.sourceKey, channel, sample.key);
    if (configured !== null) {
      cadences[sample.key] = {
        seconds: configured,
        confidence: 'configured',
        sourceKey: sample.sourceKey,
        channelId: sample.channelId,
      };
      continue;
    }
    const derived = allowDerived ? cadenceFromTimes(sample.times, referenceMs) : null;
    cadences[sample.key] = {
      seconds: derived,
      confidence: derived === null ? 'unknown' : 'derived',
      sourceKey: sample.sourceKey,
      channelId: sample.channelId,
    };
  }
  return cadences;
}

function combineCadenceConfidence(sourceCadences) {
  const values = Object.values(sourceCadences);
  if (values.length === 0 || values.some((cadence) => !cadence.seconds || cadence.confidence === 'unknown')) return 'unknown';
  return values.some((cadence) => cadence.confidence === 'derived') ? 'derived' : 'configured';
}

function commonCadenceSeconds(sourceCadences) {
  const seconds = Array.from(new Set(Object.values(sourceCadences).map((cadence) => cadence.seconds).filter(Boolean)));
  return seconds.length === 1 ? seconds[0] : null;
}

function coverageForBucket(bucketRows, channels, sourceCadences, bucketSeconds) {
  if (!bucketSeconds) return { coveragePct: null, coverageConfidence: combineCadenceConfidence(sourceCadences) };
  const entries = Object.entries(sourceCadences);
  if (entries.length === 0 || entries.some(([, cadence]) => !cadence.seconds)) {
    return { coveragePct: null, coverageConfidence: 'unknown' };
  }

  const observed = {};
  for (const entry of bucketRows) {
    for (const channel of channels) {
      if (channelValue(entry.row, channel) === null) continue;
      const key = sourceChannelKey(rowSourceKey(entry.row, channel), channel);
      observed[key] = (observed[key] || 0) + 1;
    }
  }

  let observedTotal = 0;
  let expectedTotal = 0;
  for (const [key, cadence] of entries) {
    observedTotal += observed[key] || 0;
    expectedTotal += Math.max(1, Math.ceil(bucketSeconds / cadence.seconds));
  }
  return {
    coveragePct: expectedTotal > 0 ? roundTo(Math.min(100, (observedTotal / expectedTotal) * 100)) : null,
    coverageConfidence: combineCadenceConfidence(sourceCadences),
  };
}

// `localDaysPerBucket` steps buckets by zone-local calendar dates instead of
// a fixed bucketSeconds span: 1 for a daily bucket (existing behaviour, any
// timezone) and 7 for a weekly bucket of a kind whose native step is a local
// day (zone_daily_agronomy). Stepping by local dates keeps a week at exactly
// seven dates across a clock change (final review I3/T3 I1): a fixed
// 7*86400s span pulls an eighth date into the window on the short spring day.
// Every other caller (hourly/15m/weekly of an hourly-native kind, and daily
// with no override) keeps the two branches as they were.
function aggregationBuckets(startMs, endMs, aggregation, bucketSeconds, timezone, localDaysPerBucket) {
  const buckets = [];
  const daysPerBucket = aggregation === 'daily'
    ? 1
    : (Number.isInteger(localDaysPerBucket) && localDaysPerBucket > 0 ? localDaysPerBucket : null);

  if (daysPerBucket === null) {
    for (let bucketStartMs = startMs; bucketStartMs < endMs; bucketStartMs += bucketSeconds * 1000) {
      const bucketEndMs = Math.min(endMs, bucketStartMs + bucketSeconds * 1000);
      buckets.push({
        bucketStartMs,
        bucketEndMs,
        bucketStart: new Date(bucketStartMs).toISOString(),
        bucketEnd: new Date(bucketEndMs).toISOString(),
        series: {},
        sampleCount: 0,
        eventCount: 0,
        thresholdCrossingCount: 0,
      });
    }
    return buckets;
  }

  let bucketStartMs = startMs;
  let dateKey = localDateKey(bucketStartMs, timezone) || new Date(bucketStartMs).toISOString().slice(0, 10);
  while (bucketStartMs < endMs) {
    let nextDateKey = dateKey;
    for (let step = 0; step < daysPerBucket; step += 1) nextDateKey = addIsoDays(nextDateKey, 1);
    const nextStartMs = Date.parse(zoneDateStartIso(nextDateKey, timezone));
    const bucketEndMs = Math.min(endMs, Number.isFinite(nextStartMs) && nextStartMs > bucketStartMs ? nextStartMs : bucketStartMs + bucketSeconds * 1000);
    buckets.push({
      bucketStartMs,
      bucketEndMs,
      bucketStart: new Date(bucketStartMs).toISOString(),
      bucketEnd: new Date(bucketEndMs).toISOString(),
      series: {},
      sampleCount: 0,
      eventCount: 0,
      thresholdCrossingCount: 0,
    });
    bucketStartMs = bucketEndMs;
    dateKey = nextDateKey;
  }
  return buckets;
}

// aggregationBuckets recomputes bucket geometry (Intl-heavy for a daily or
// local-weekly span) from scratch every call; a weather request resolves one
// series per selected channel and every channel of one group shares the same
// range/aggregation/timezone, so the geometry is identical across all of
// them (final review I3, queue T3 I2). `cache`, when given, is a Map scoped
// to one resolveAnalysisSeries call: the first call for a given key computes
// the skeleton once, every later call for the same key clones its boundary
// fields into fresh, independently-mutable bucket objects.
function bucketSkeletonFor(startMs, endMs, aggregation, bucketSeconds, timezone, localDaysPerBucket, cache) {
  if (!cache) return aggregationBuckets(startMs, endMs, aggregation, bucketSeconds, timezone, localDaysPerBucket);
  const key = `${startMs}|${endMs}|${aggregation}|${bucketSeconds}|${timezone || ''}|${localDaysPerBucket || ''}`;
  let skeleton = cache.get(key);
  if (!skeleton) {
    skeleton = aggregationBuckets(startMs, endMs, aggregation, bucketSeconds, timezone, localDaysPerBucket);
    cache.set(key, skeleton);
  }
  return skeleton.map((bucket) => ({
    bucketStartMs: bucket.bucketStartMs,
    bucketEndMs: bucket.bucketEndMs,
    bucketStart: bucket.bucketStart,
    bucketEnd: bucket.bucketEnd,
    series: {},
    sampleCount: 0,
    eventCount: 0,
    thresholdCrossingCount: 0,
  }));
}

function aggregateRows(rows, options = {}) {
  const aggregationInfo = resolveAggregation(options);
  const aggregation = aggregationInfo.level;
  const aggregationRequested = options.aggregationRequested || aggregationInfo.requested;
  const channels = filterSoilChannelsForSources(options.channels, options.sourceDevices);
  const startMs = parseTime(options.start || options.startAt || options.from);
  const endMs = parseTime(options.end || options.endAt || options.to);
  if (channels.length === 0) throw new Error('aggregateRows requires at least one channel');

  const sortedRows = filterSoilRowsForSources(rows, options.sourceDevices)
    .map((row) => ({ row, recordedAtMs: parseRecordedAtMs(row.recorded_at || row.recordedAt) }))
    .filter((entry) => entry.recordedAtMs !== null)
    .filter((entry) => (startMs === null || entry.recordedAtMs >= startMs) && (endMs === null || entry.recordedAtMs < endMs))
    .sort((a, b) => a.recordedAtMs - b.recordedAtMs);

  const channelSourceKeys = {};
  for (const channel of channels) {
    for (let index = sortedRows.length - 1; index >= 0; index -= 1) {
      if (channelValue(sortedRows[index].row, channel) !== null) {
        channelSourceKeys[channel.id] = rowSourceKey(sortedRows[index].row, channel);
        break;
      }
    }
  }

  const sourceCadences = deriveSourceCadences(sortedRows, channels, options, aggregation !== 'raw');
  const cadence = {
    seconds: commonCadenceSeconds(sourceCadences),
    confidence: combineCadenceConfidence(sourceCadences),
  };

  if (aggregation === 'raw') {
    const series = {};
    for (const channel of channels) {
      series[channel.id] = {
        unit: channel.unit || null,
        points: sortedRows
          .map((entry) => ({ recordedAt: new Date(entry.recordedAtMs).toISOString(), value: channelValue(entry.row, channel) }))
          .filter((point) => point.value !== null),
      };
    }
    return {
      aggregation: 'raw',
      aggregationRequested,
      bucketSizeSeconds: null,
      source: 'device_data',
      channelSourceKeys,
      expectedCadenceSeconds: cadence.seconds,
      coverageConfidence: cadence.confidence,
      coveragePct: null,
      sourceCadences,
      series,
    };
  }

  const bucketSeconds = BUCKET_SECONDS[aggregation];
  if (!bucketSeconds) throw new Error(`unsupported aggregation: ${aggregation}`);
  if (startMs === null || endMs === null || endMs <= startMs) throw new Error('aggregateRows requires a valid start/end range for bucketed aggregation');

  const buckets = bucketSkeletonFor(startMs, endMs, aggregation, bucketSeconds, options.timezone, options.localDaysPerBucket, options.bucketSkeletonCache);
  const nowMs = toFiniteNumber(options.nowMs) ?? Date.now();

  // sortedRows and buckets are both ascending and buckets are contiguous
  // over [startMs, endMs) with no gaps or overlaps, so one forward pass
  // assigns every row to its bucket instead of re-scanning the full row
  // list per bucket (final review I3, queue T3 I2: buckets x rows
  // comparisons dominated a multi-hundred-bucket weather request).
  let rowCursor = 0;
  for (const bucket of buckets) {
    const bucketRows = [];
    while (rowCursor < sortedRows.length && sortedRows[rowCursor].recordedAtMs < bucket.bucketEndMs) {
      bucketRows.push(sortedRows[rowCursor]);
      rowCursor += 1;
    }
    for (const channel of channels) {
      const stats = statsForValues(bucketRows.map((entry) => ({ value: channelValue(entry.row, channel), recordedAtMs: entry.recordedAtMs })));
      bucket.series[channel.id] = stats ? { ...stats, unit: channel.unit || null } : {
        min: null,
        max: null,
        mean: null,
        median: null,
        latest: null,
        sampleCount: 0,
        sum: null,
        unit: channel.unit || null,
      };
      bucket.sampleCount += bucket.series[channel.id].sampleCount;
    }
    // Coverage denominator counts only elapsed time: a bucket (or window)
    // that extends past `now` cannot be "missing" samples it could not
    // yet have received. Fully-future buckets get a zero denominator,
    // which coverageForBucket maps to coveragePct null.
    const elapsedBucketSeconds = Math.max(0, (Math.min(bucket.bucketEndMs, nowMs) - bucket.bucketStartMs) / 1000);
    const coverage = coverageForBucket(bucketRows, channels, sourceCadences, elapsedBucketSeconds);
    bucket.coveragePct = coverage.coveragePct;
    bucket.coverageConfidence = coverage.coverageConfidence;
    delete bucket.bucketStartMs;
    delete bucket.bucketEndMs;
  }

  const totalSamples = buckets.reduce((sum, bucket) => sum + bucket.sampleCount, 0);
  const totalSeconds = Math.max(0, (Math.min(endMs, nowMs) - startMs) / 1000);
  const totalCoverage = coverageForBucket(sortedRows, channels, sourceCadences, totalSeconds);
  return {
    aggregation,
    aggregationRequested,
    bucketSizeSeconds: aggregationInfo.bucketSizeSeconds,
    source: 'device_data',
    channelSourceKeys,
    expectedCadenceSeconds: cadence.seconds,
    coverageConfidence: totalCoverage.coverageConfidence,
    coveragePct: totalCoverage.coveragePct,
    sourceCadences,
    buckets,
  };
}

function dbAll(db, sql, params) {
  return new Promise((resolve, reject) => {
    if (!db || typeof db.all !== 'function') return reject(new Error('aggregateDeviceData requires db.all'));
    try {
      if (db.all.length >= 3) {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
        return undefined;
      }
      const result = db.all(sql, params);
      if (result && typeof result.then === 'function') return result.then(resolve, reject);
      return resolve(result || []);
    } catch (error) {
      return reject(error);
    }
  });
}

function dbRun(db, sql, params) {
  return new Promise((resolve, reject) => {
    if (!db || typeof db.run !== 'function') return reject(new Error('upsertRollups requires db.run'));
    try {
      if (db.run.length >= 3) {
        db.run(sql, params, function(error) {
          if (error) return reject(error);
          return resolve(this && typeof this.changes === 'number' ? this.changes : 0);
        });
        return undefined;
      }
      const result = db.run(sql, params);
      if (result && typeof result.then === 'function') return result.then(resolve, reject);
      return resolve(result && typeof result.changes === 'number' ? result.changes : 0);
    } catch (error) {
      return reject(error);
    }
  });
}

function normalizeQueryChannels(channels) {
  const normalized = normalizeChannels(channels);
  if (normalized.length === 0) throw new Error('aggregateDeviceData requires channels');
  for (const channel of normalized) {
    const unsupportedField = channelFieldNames(channel).find((field) => !ALLOWED_DEVICE_DATA_CHANNELS.has(field));
    if (unsupportedField) throw new Error(`unsupported device_data channel: ${unsupportedField}`);
  }
  return normalized;
}

/** Aggregates the UNION of scope.deveuis into one combined row per bucket/channel under scope.logicalSourceKey. */
async function computeRollupBuckets(db, scope = {}, level, windowMs, nowMs) {
  const aggregation = String(level || '').trim();
  if (!['hourly', 'daily', 'weekly'].includes(aggregation)) throw new Error(`unsupported rollup level: ${level}`);
  const channels = normalizeQueryChannels(filterSoilChannelsForSources(scope.channels, scope.sourceDevices));
  const deveuis = Array.from(new Set((Array.isArray(scope.deveuis) ? scope.deveuis : [])
    .map(normalizeDeveui)
    .filter(Boolean)));
  if (deveuis.length === 0 || channels.length === 0) return [];

  const todayStartMs = startOfLocalDayMs(nowMs ?? Date.now(), scope.timezone || 'UTC');
  const startMs = todayStartMs - Math.max(0, Number(windowMs || 0));
  if (!Number.isFinite(startMs) || startMs >= todayStartMs) return [];
  const start = new Date(startMs).toISOString();
  const end = new Date(todayStartMs).toISOString();
  const placeholders = deveuis.map(() => '?').join(',');
  const selectedFields = Array.from(new Set(channels.flatMap(channelFieldNames)));
  const range = recordedAtRangeSql('recorded_at', start, end);
  const sql = `SELECT deveui, recorded_at, ${selectedFields.join(', ')} FROM device_data WHERE deveui IN (${placeholders}) AND ${range.sql} ORDER BY recorded_at ASC`;
  const rows = await dbAll(db, sql, deveuis.concat(range.params));
  const result = aggregateRows(rows, { aggregation, channels, start, end, timezone: scope.timezone, expectedCadences: scope.expectedCadences || scope.expected_cadences, sourceDevices: scope.sourceDevices });
  const out = [];
  for (const bucket of result.buckets || []) {
    for (const channel of channels) {
      const stats = bucket.series && bucket.series[channel.id];
      if (!stats || Number(stats.sampleCount || 0) === 0) continue;
      out.push({
        zone_id: scope.zoneId ?? scope.zone_id,
        card_type: normalizeCardType(scope.cardType || scope.card_type),
        logical_source_key: scope.logicalSourceKey || scope.logical_source_key,
        channel_id: channel.id,
        bucket_level: aggregation,
        bucket_start: bucket.bucketStart,
        bucket_end: bucket.bucketEnd,
        min_value: stats.min,
        max_value: stats.max,
        mean_value: stats.mean,
        median_value: stats.median,
        latest_value: stats.latest,
        dominant_status: stats.dominantStatus || null,
        coverage_pct: bucket.coveragePct ?? null,
        coverage_confidence: bucket.coverageConfidence || 'unknown',
        sample_count: Number(stats.sampleCount || 0),
        event_count: Number(stats.eventCount || 0),
        threshold_crossing_count: Number(stats.thresholdCrossingCount || 0),
        unit: channel.unit || stats.unit || null,
      });
    }
  }
  return out;
}

async function upsertRollups(db, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const cols = [
    'zone_id',
    'card_type',
    'logical_source_key',
    'channel_id',
    'bucket_level',
    'bucket_start',
    'bucket_end',
    'min_value',
    'max_value',
    'mean_value',
    'median_value',
    'latest_value',
    'dominant_status',
    'coverage_pct',
    'coverage_confidence',
    'sample_count',
    'event_count',
    'threshold_crossing_count',
    'unit',
  ];
  const keyCols = new Set(['zone_id', 'card_type', 'logical_source_key', 'channel_id', 'bucket_level', 'bucket_start']);
  const updateCols = cols.filter((col) => !keyCols.has(col));
  const sql = `INSERT INTO history_channel_rollups (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT(zone_id,card_type,logical_source_key,channel_id,bucket_level,bucket_start) DO UPDATE SET ${updateCols.map((col) => `${col}=excluded.${col}`).join(', ')}`;
  let count = 0;
  for (const row of rows) {
    await dbRun(db, sql, cols.map((col) => row[col] ?? null));
    count += 1;
  }
  return count;
}

/**
 * Builds an aggregate result from history_channel_rollups rows.
 *
 * CONTRACT (verified live on kaba100, 2026-07-11):
 * - Input rows MUST all belong to ONE logical_source_key. Merged cards
 *   (soil='root-zone', environment='microclimate') store ONE combined-
 *   aggregate row per bucket/channel — computeRollupBuckets aggregates the
 *   UNION of the card's devices before upserting. Per-source detail exists
 *   only in raw device_data and the CSV export path.
 * - bucket.series is keyed by channel_id only; multi-key input would
 *   silently drop data, hence the guard below. A future per-source rollup
 *   scheme must extend this keying (see refactor-program open decisions).
 * - bucket.sampleCount sums sample_count ACROSS CHANNELS (same semantics
 *   as the live aggregateRows path).
 */
function rollupRowsToResult(rows, query, channels) {
  const sourceKeys = new Set((rows || [])
    .map((row) => row.logical_source_key)
    .filter((value) => value !== undefined && value !== null));
  if (sourceKeys.size > 1) {
    throw new Error(`rollupRowsToResult requires rows from a single logical_source_key, got: ${Array.from(sourceKeys).sort().join(', ')}`);
  }
  const channelMap = new Map(channels.map((channel) => [channel.id, channel]));
  const byBucket = new Map();
  for (const row of rows || []) {
    const key = row.bucket_start;
    if (!byBucket.has(key)) {
      byBucket.set(key, {
        bucketStart: row.bucket_start,
        bucketEnd: row.bucket_end,
        series: {},
        sampleCount: 0,
        eventCount: 0,
        thresholdCrossingCount: 0,
        coverageValues: [],
        coverageConfidences: [],
      });
    }
    const bucket = byBucket.get(key);
    const channelId = row.channel_id;
    if (!channelMap.has(channelId)) continue;
    bucket.series[channelId] = {
      min: toFiniteNumber(row.min_value),
      max: toFiniteNumber(row.max_value),
      mean: toFiniteNumber(row.mean_value),
      median: toFiniteNumber(row.median_value),
      latest: toFiniteNumber(row.latest_value),
      // history_channel_rollups has no sum column (it predates the sum stat,
      // final review A5): a rolled-up bucket never reports a channel total,
      // only a live aggregateRows call over device_data can.
      sum: null,
      dominantStatus: row.dominant_status || null,
      sampleCount: Number(row.sample_count || 0),
      eventCount: Number(row.event_count || 0),
      thresholdCrossingCount: Number(row.threshold_crossing_count || 0),
      unit: row.unit || channelMap.get(channelId).unit || null,
    };
    bucket.sampleCount += Number(row.sample_count || 0);
    bucket.eventCount += Number(row.event_count || 0);
    bucket.thresholdCrossingCount += Number(row.threshold_crossing_count || 0);
    const coverage = toFiniteNumber(row.coverage_pct);
    if (coverage !== null) bucket.coverageValues.push(coverage);
    bucket.coverageConfidences.push(row.coverage_confidence || 'unknown');
  }

  const buckets = Array.from(byBucket.values()).map((bucket) => {
    for (const channel of channels) {
      if (!bucket.series[channel.id]) {
        bucket.series[channel.id] = { min: null, max: null, mean: null, median: null, latest: null, dominantStatus: null, sampleCount: 0, eventCount: 0, thresholdCrossingCount: 0, unit: channel.unit || null };
      }
    }
    const coveragePct = bucket.coverageValues.length
      ? roundTo(bucket.coverageValues.reduce((sum, value) => sum + value, 0) / bucket.coverageValues.length)
      : null;
    const coverageConfidence = bucket.coverageConfidences.includes('unknown')
      ? 'unknown'
      : (bucket.coverageConfidences.includes('derived') ? 'derived' : 'configured');
    return {
      bucketStart: bucket.bucketStart,
      bucketEnd: bucket.bucketEnd,
      series: bucket.series,
      sampleCount: bucket.sampleCount,
      eventCount: bucket.eventCount,
      thresholdCrossingCount: bucket.thresholdCrossingCount,
      coveragePct,
      coverageConfidence,
    };
  });

  const coverageValues = buckets.map((bucket) => bucket.coveragePct).filter((value) => value !== null);
  const coverageConfidence = buckets.some((bucket) => bucket.coverageConfidence === 'unknown')
    ? 'unknown'
    : (buckets.some((bucket) => bucket.coverageConfidence === 'derived') ? 'derived' : 'configured');
  return {
    aggregation: query.aggregation,
    aggregationRequested: query.aggregationRequested || query.aggregation,
    bucketSizeSeconds: BUCKET_SECONDS[query.aggregation] || null,
    source: 'history_channel_rollups',
    coverageConfidence: buckets.length ? coverageConfidence : 'unknown',
    coveragePct: coverageValues.length ? roundTo(coverageValues.reduce((sum, value) => sum + value, 0) / coverageValues.length) : null,
    buckets,
  };
}

function firstDefinedValue(values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function queryDeviceEuis(query = {}) {
  const values = [];
  for (const list of [
    query.deveuis,
    query.deviceEuis,
    query.device_euis,
    query.sourceKeys,
    query.source_keys,
    query.sourceDevices,
    query.source_devices,
  ]) {
    if (Array.isArray(list)) values.push(...list);
  }
  values.push(
    query.deveui,
    query.deviceEui,
    query.device_eui,
    query.sourceKey,
    query.source_key
  );
  return Array.from(new Set(values.map(normalizeSourceKey).map(normalizeDeveui).filter(Boolean)));
}

async function aggregateDeviceData(db, query = {}) {
  const aggregationInfo = resolveAggregation(query);
  const aggregation = aggregationInfo.level;
  const channels = normalizeQueryChannels(filterSoilChannelsForSources(query.channels, query.sourceDevices));
  const start = query.start || query.startAt || query.from;
  const end = query.end || query.endAt || query.to;
  if (!start || !end) throw new Error('aggregateDeviceData requires start and end');

  const zoneId = firstDefinedValue([query.zoneId, query.zone_id]);
  const cardType = firstDefinedValue([query.cardType, query.card_type]);
  const logicalSourceKey = firstDefinedValue([query.logicalSourceKey, query.logical_source_key]);
  const useRollups = query.useRollups ?? query.use_rollups;
  const hasRollupIdentity = zoneId !== undefined && cardType && logicalSourceKey;
  const deveuis = queryDeviceEuis(query);
  const sourceFilterFlag = query.sourceFilterActive ?? query.source_filter_active;
  const hasSourceFilter = sourceFilterFlag === true || sourceFilterFlag === 1 || String(sourceFilterFlag || '').toLowerCase() === 'true';
  const shouldUseRollups =
    !hasSourceFilter
    && (useRollups === true || (useRollups !== false && hasRollupIdentity && ['hourly', 'daily', 'weekly'].includes(aggregation)));
  if (shouldUseRollups) {
    const startMs = parseTime(start);
    const endMs = parseTime(end);
    if (startMs === null || endMs === null || endMs <= startMs) throw new Error('aggregateDeviceData requires a valid start/end range');
    const todayStartMs = startOfLocalDayMs(query.nowMs ?? Date.now(), query.timezone || query.time_zone || 'UTC');
    const splitMs = Math.min(Math.max(todayStartMs, startMs), endMs);
    const splitIso = new Date(splitMs).toISOString();
    const channelIds = channels.map((channel) => channel.id);
    const placeholders = channelIds.map(() => '?').join(',');
    let rollupRows = [];
    if (splitMs > startMs) {
      const sql = `SELECT * FROM history_channel_rollups WHERE zone_id = ? AND card_type = ? AND logical_source_key = ? AND bucket_level = ? AND bucket_start >= ? AND bucket_start < ? AND channel_id IN (${placeholders}) ORDER BY bucket_start ASC, channel_id ASC`;
      const params = [zoneId, cardType, logicalSourceKey, aggregation, start, splitIso].concat(channelIds);
      rollupRows = await dbAll(db, sql, params);
    }
    const completed = rollupRowsToResult(rollupRows, { ...query, aggregation, aggregationRequested: aggregationInfo.requested }, channels);
    let live = null;
    const hasTrailingWindow = splitMs < endMs;
    if (hasTrailingWindow && deveuis.length > 0) {
      const livePlaceholders = deveuis.map(() => '?').join(',');
      const selectedFields = Array.from(new Set(channels.flatMap(channelFieldNames)));
      const range = recordedAtRangeSql('recorded_at', splitIso, end);
      const sql = `SELECT deveui, recorded_at, ${selectedFields.join(', ')} FROM device_data WHERE deveui IN (${livePlaceholders}) AND ${range.sql} ORDER BY recorded_at ASC`;
      const rows = await dbAll(db, sql, deveuis.concat(range.params));
      live = aggregateRows(rows, { ...query, aggregation, aggregationRequested: aggregationInfo.requested, channels, start: splitIso, end, sourceDevices: query.sourceDevices });
    }
    if (rollupRows.length || live) {
      const buckets = (completed.buckets || []).concat(live && live.buckets || [])
        .sort((left, right) => String(left.bucketStart).localeCompare(String(right.bucketStart)));
      const coverageValues = buckets.map((bucket) => toFiniteNumber(bucket.coveragePct)).filter((value) => value !== null);
      const coverageConfidence = buckets.some((bucket) => bucket.coverageConfidence === 'unknown')
        ? 'unknown'
        : (buckets.some((bucket) => bucket.coverageConfidence === 'derived') ? 'derived' : (buckets.length ? 'configured' : 'unknown'));
      return {
        ...completed,
        source: rollupRows.length && live ? 'rollups+live' : (rollupRows.length ? 'history_channel_rollups' : 'device_data'),
        coverageConfidence,
        coveragePct: coverageValues.length ? roundTo(coverageValues.reduce((sum, value) => sum + value, 0) / coverageValues.length) : null,
        buckets,
      };
    }
  }

  if (deveuis.length === 0) throw new Error('aggregateDeviceData requires at least one DevEUI');
  const placeholders = deveuis.map(() => '?').join(',');
  const selectedFields = Array.from(new Set(channels.flatMap(channelFieldNames)));
  const range = recordedAtRangeSql('recorded_at', start, end, { endInclusive: true });
  const sql = `SELECT deveui, recorded_at, ${selectedFields.join(', ')} FROM device_data WHERE deveui IN (${placeholders}) AND ${range.sql} ORDER BY deveui ASC, recorded_at ASC`;
  const params = deveuis.concat(range.params);
  const rows = await dbAll(db, sql, params);
  const result = aggregateRows(rows, { ...query, aggregation, aggregationRequested: aggregationInfo.requested, channels, start, end, sourceDevices: query.sourceDevices });
  if (shouldUseRollups) result.source = 'device_data_fallback';
  return result;
}

function canonicalHistoryField(field) {
  const normalized = String(field || '').trim();
  return LEGACY_FIELD_ALIASES[normalized] || normalized;
}

function legacyFieldExpression(field) {
  const normalized = String(field || '').trim();
  if (!LEGACY_SENSOR_HISTORY_FIELDS.has(normalized)) return null;
  return LEGACY_FIELD_EXPRESSIONS[normalized] || `dd.${normalized}`;
}

function optionalUserFilter(options = {}, alias = 'd') {
  const userId = toFiniteNumber(options.userId ?? options.user_id);
  return userId === null ? { sql: '', params: [] } : { sql: ` AND ${alias}.user_id = ?`, params: [Math.round(userId)] };
}

async function resolveDeviceFieldRollupKey(db, deveui, field, options = {}) {
  const normalizedDeveui = normalizeDeveui(deveui);
  const normalizedField = String(field || '').trim();
  if (!normalizedDeveui || !normalizedField) return null;
  const rollupField = canonicalHistoryField(normalizedField);
  const ownerFilter = optionalUserFilter(options, 'd');

  const deviceRows = await dbAll(db, `
    SELECT
      d.*,
      z.id AS zone_id,
      z.name AS zone_name,
      z.zone_uuid AS zone_uuid,
      z.timezone AS zone_timezone
    FROM devices d
    JOIN irrigation_zones z ON z.id = d.irrigation_zone_id
    WHERE d.deveui = ?
      AND d.deleted_at IS NULL
      AND z.deleted_at IS NULL
      ${ownerFilter.sql}
    LIMIT 1
  `, [normalizedDeveui].concat(ownerFilter.params));
  const device = deviceRows[0];
  if (!device || device.zone_id === null || device.zone_id === undefined) return null;

  const zone = {
    id: device.zone_id,
    name: device.zone_name,
    zone_uuid: device.zone_uuid,
    timezone: device.zone_timezone || 'UTC',
  };
  const zoneDeviceFilter = optionalUserFilter(options, 'devices');
  const devices = await annotateWatermarkEvidence(db, await dbAll(db, `SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ?${zoneDeviceFilter.sql} ORDER BY deveui ASC`, [device.zone_id].concat(zoneDeviceFilter.params)));
  const cards = deriveCardsForZone(zone, devices);
  for (const card of cards) {
    const sourceDevices = sourceDevicesForCard(card, devices);
    const channel = channelsForCard(card, [device]).find((candidate) =>
      candidate.id === rollupField || candidate.field === rollupField
    );
    if (!channel) continue;
    const sourceDeveuis = uniqueDeveuis(sourceDevices);
    if (!sourceDeveuis.includes(normalizedDeveui)) continue;
    return {
      zoneId: Number(device.zone_id),
      zoneUuid: String(device.zone_uuid || ''),
      cardType: card.cardType,
      logicalSourceKey: card.logicalSourceKey,
      channelId: channel.id,
      field: normalizedField,
      channel,
      channels: [channel],
      deveuis: sourceDeveuis,
      timezone: zone.timezone || 'UTC',
    };
  }
  return null;
}

async function rawLegacySensorHistory(db, options = {}) {
  const normalizedDeveui = normalizeDeveui(options.deveui || options.deviceEui || options.device_eui);
  const field = String(options.field || '').trim();
  const expression = legacyFieldExpression(field);
  if (!normalizedDeveui) return [];
  if (!expression) {
    const error = new Error('Invalid field');
    error.statusCode = 400;
    throw error;
  }
  const start = options.start;
  const end = options.end;
  if (!start || !end) throw new Error('rawLegacySensorHistory requires start and end');
  const ownerFilter = optionalUserFilter(options, 'dv');
  const limit = Math.max(1, Math.min(30000, Math.round(toFiniteNumber(options.limit) || 30000)));
  const range = recordedAtRangeSql('dd.recorded_at', start, end);
  const rows = await dbAll(db, `
    SELECT dd.recorded_at, ${expression} AS value
    FROM device_data dd
    JOIN devices dv ON dv.deveui = dd.deveui
    WHERE dd.deveui = ?
      ${ownerFilter.sql}
      AND ${expression} IS NOT NULL
      AND ${range.sql}
    ORDER BY dd.recorded_at ASC
    LIMIT ?
  `, [normalizedDeveui].concat(ownerFilter.params, range.params, [limit]));
  return sortByRecordedAt(rows.filter(recordedAtRangeFilter(start, end)))
    .map((row) => ({ t: canonicalRecordedAt(row.recorded_at), value: toFiniteNumber(row.value) }));
}

function legacyAggregationForHours(hours) {
  if (hours <= 24) return 'raw';
  if (hours <= 48) return '15m';
  if (hours <= 8 * 24) return 'hourly';
  if (hours <= 120 * 24) return 'daily';
  return 'weekly';
}

function flattenLegacyAggregate(result, channelId) {
  const points = [];
  if (Array.isArray(result && result.buckets)) {
    for (const bucket of result.buckets) {
      const stats = bucket.series && bucket.series[channelId];
      if (!stats || Number(stats.sampleCount || 0) === 0) continue;
      const value = toFiniteNumber(stats.latest) ?? toFiniteNumber(stats.mean);
      if (value === null) continue;
      points.push({ t: bucket.bucketStart, value });
    }
  } else if (result && result.series && result.series[channelId]) {
    for (const point of result.series[channelId].points || []) {
      const value = toFiniteNumber(point.value);
      if (value !== null) points.push({ t: point.t || point.recorded_at || point.recordedAt, value });
    }
  }
  return points.sort((left, right) => String(left.t).localeCompare(String(right.t)));
}

function dendroHistoryRow(row) {
  return {
    t: row.recorded_at || row.t,
    position_raw_mm: toFiniteNumber(row.position_raw_mm ?? row.dendro_position_raw_mm),
    position_mm: toFiniteNumber(row.position_mm ?? row.dendro_position_mm),
    delta_mm: toFiniteNumber(row.delta_mm ?? row.dendro_delta_mm),
    stem_change_um: toFiniteNumber(row.stem_change_um ?? row.dendro_stem_change_um),
    adc_v: toFiniteNumber(row.adc_v ?? row.adc_ch0v),
    adc_ch0v: toFiniteNumber(row.adc_ch0v ?? row.adc_v),
    adc_ch1v: toFiniteNumber(row.adc_ch1v),
    dendro_ratio: toFiniteNumber(row.dendro_ratio),
    dendro_mode_used: row.dendro_mode_used || null,
    saturated: toFiniteNumber(row.saturated ?? row.dendro_saturated),
    saturation_side: row.saturation_side ?? row.dendro_saturation_side ?? null,
    valid: toFiniteNumber(row.valid ?? row.dendro_valid) ?? 0,
  };
}

async function rawLegacyDendroHistory(db, options = {}) {
  const normalizedDeveui = normalizeDeveui(options.deveui || options.deviceEui || options.device_eui);
  if (!normalizedDeveui) return [];
  const start = options.start;
  const end = options.end;
  if (!start || !end) throw new Error('rawLegacyDendroHistory requires start and end');
  const ownerFilter = optionalUserFilter(options, 'dv');
  const range = recordedAtRangeSql('dd.recorded_at', start, end);
  const rows = await dbAll(db, `
    SELECT
      dd.recorded_at,
      dd.dendro_position_raw_mm,
      dd.dendro_position_mm,
      dd.dendro_delta_mm,
      dd.dendro_stem_change_um,
      dd.adc_ch0v,
      dd.adc_ch1v,
      dd.dendro_ratio,
      dd.dendro_mode_used,
      dd.dendro_saturated,
      dd.dendro_saturation_side,
      COALESCE(dd.dendro_valid, 1) AS dendro_valid
    FROM device_data dd
    JOIN devices dv ON dv.deveui = dd.deveui
    WHERE dd.deveui = ?
      ${ownerFilter.sql}
      AND ${range.sql}
      AND (dd.dendro_position_mm IS NOT NULL OR dd.adc_ch0v IS NOT NULL OR dd.adc_ch1v IS NOT NULL OR dd.dendro_ratio IS NOT NULL)
    ORDER BY dd.recorded_at ASC
    LIMIT 30000
  `, [normalizedDeveui].concat(ownerFilter.params, range.params));
  return sortByRecordedAt(rows.filter(recordedAtRangeFilter(start, end)))
    .map((row) => dendroHistoryRow({ ...row, recorded_at: canonicalRecordedAt(row.recorded_at) }));
}

function mergeDendroAggregateField(byTime, field, points) {
  const propertyMap = {
    dendro_position_raw_mm: 'position_raw_mm',
    dendro_position_mm: 'position_mm',
    dendro_delta_mm: 'delta_mm',
    dendro_stem_change_um: 'stem_change_um',
    adc_ch0v: 'adc_ch0v',
    adc_ch1v: 'adc_ch1v',
    dendro_ratio: 'dendro_ratio',
  };
  const property = propertyMap[field];
  if (!property) return;
  for (const point of points || []) {
    if (!point || !point.t) continue;
    if (!byTime.has(point.t)) byTime.set(point.t, { t: point.t, valid: 1 });
    const row = byTime.get(point.t);
    row[property] = point.value;
    if (field === 'adc_ch0v') row.adc_v = point.value;
  }
}

async function aggregateLegacyDendroHistory(db, options = {}) {
  const byTime = new Map();
  for (const field of DENDRO_HISTORY_FIELDS) {
    const points = await legacySensorHistory(db, { ...options, mode: null, field });
    mergeDendroAggregateField(byTime, field, points);
  }
  return Array.from(byTime.values())
    .map((row) => dendroHistoryRow(row))
    .sort((left, right) => String(left.t).localeCompare(String(right.t)));
}

const LEGACY_INTERVAL_FIELDS = new Set(['rain_mm_delta', 'rain_tips_delta', 'flow_liters_delta', 'flow_pulses_delta']);

async function legacySensorHistory(db, options = {}) {
  const hoursRaw = toFiniteNumber(options.hours);
  const hours = hoursRaw !== null && hoursRaw > 0 ? hoursRaw : 24;
  const endMs = options.nowMs ?? Date.now();
  const end = new Date(endMs).toISOString();
  const start = new Date(endMs - (hours * 60 * 60 * 1000)).toISOString();
  const scopedOptions = { ...options, start, end };
  if (String(options.mode || '').toLowerCase() === 'dendro') {
    return hours <= 24
      ? rawLegacyDendroHistory(db, scopedOptions)
      : aggregateLegacyDendroHistory(db, scopedOptions);
  }

  const field = String(options.field || '').trim();
  if (!field) {
    const error = new Error('Missing field');
    error.statusCode = 400;
    throw error;
  }
  if (hours <= 24) return rawLegacySensorHistory(db, scopedOptions);
  // Rollups keep no bucket sum, and their latest value is one uplink's
  // interval, so interval channels stay on raw rows at every range.
  if (LEGACY_INTERVAL_FIELDS.has(canonicalHistoryField(field))) return rawLegacySensorHistory(db, scopedOptions);

  const key = await resolveDeviceFieldRollupKey(db, options.deveui || options.deviceEui || options.device_eui, field, options);
  if (!key) return rawLegacySensorHistory(db, scopedOptions);
  const aggregation = legacyAggregationForHours(hours);
  const result = await aggregateDeviceData(db, {
    zoneId: key.zoneId,
    cardType: key.cardType,
    logicalSourceKey: key.logicalSourceKey,
    device_euis: key.deveuis,
    start,
    end,
    aggregation,
    channels: key.channels,
    timezone: key.timezone,
    nowMs: endMs,
  });
  return flattenLegacyAggregate(result, key.channelId);
}

// A device's farm timezone: its zone's, else the lowest-id live zone it is a
// weather station for, else UTC. Never the gateway host's or the viewer's.
// `basis` says where the answer came from: 'zone', 'weather_station_zone',
// 'unassigned_default' (no zone, or a device the caller does not own, which
// answers like an unassigned one), 'abbreviation' (a valid zone value that is
// not a region name, e.g. CET: kept as stored, flagged so the zone settings
// can prompt for a region) or 'invalid' (not a timezone; answered in UTC).
const UNASSIGNED_TIMEZONE = Object.freeze({ timezone: 'UTC', basis: 'unassigned_default' });

function classifyTimezone(raw) {
  const tz = String(raw == null ? '' : raw).trim();
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch (_) {
    return { timezone: 'UTC', basis: 'invalid' };
  }
  const upper = tz.toUpperCase();
  if (upper === 'UTC' || upper === 'ETC/UTC' || tz.includes('/')) return { timezone: tz, basis: null };
  return { timezone: tz, basis: 'abbreviation' };
}

async function resolveDeviceTimezones(db, deveuis, options = {}) {
  const list = Array.from(new Set((deveuis || []).map(normalizeDeveui).filter(Boolean)));
  const out = new Map();
  for (const eui of list) out.set(eui, { ...UNASSIGNED_TIMEZONE });
  if (!list.length) return out;
  const ownerFilter = optionalUserFilter(options, 'd');
  const placeholders = list.map(() => '?').join(',');
  const rows = await dbAll(db, `
    SELECT d.deveui,
           iz.timezone AS zone_tz,
           (SELECT iz2.timezone
              FROM weather_station_zones w
              JOIN irrigation_zones iz2 ON iz2.id = w.zone_id AND iz2.deleted_at IS NULL
             WHERE w.deveui = d.deveui
             ORDER BY w.zone_id
             LIMIT 1) AS station_tz
      FROM devices d
      LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL
     WHERE d.deveui IN (${placeholders}) AND d.deleted_at IS NULL${ownerFilter.sql}
  `, list.concat(ownerFilter.params));
  for (const row of rows) {
    const eui = normalizeDeveui(row.deveui);
    if (!eui) continue;
    const fromZone = classifyTimezone(row.zone_tz);
    const fromStation = classifyTimezone(row.station_tz);
    const pick = fromZone ? { timezone: fromZone.timezone, basis: fromZone.basis || 'zone' }
      : fromStation ? { timezone: fromStation.timezone, basis: fromStation.basis || 'weather_station_zone' }
        : { ...UNASSIGNED_TIMEZONE };
    out.set(eui, pick);
  }
  return out;
}

async function resolveDeviceTimezone(db, deveui, options = {}) {
  const eui = normalizeDeveui(deveui);
  if (!eui) return { ...UNASSIGNED_TIMEZONE };
  const map = await resolveDeviceTimezones(db, [eui], options);
  return map.get(eui) || { ...UNASSIGNED_TIMEZONE };
}

const RAIN_HISTORY_MAX_DAYS = 366;
const RAIN_HISTORY_MAX_TZ_OFFSET_MIN = 840;
const RAIN_DAY_MS = 24 * 60 * 60 * 1000;

// Daily rainfall totals for one device, bucketed by *local* calendar day.
// tzOffsetMin = minutes to ADD to UTC to get local wall time (JS convention:
// -new Date().getTimezoneOffset()). Uses SUM over rain_mm_delta because the
// stored rollups (history_channel_rollups) keep no sum column and their
// latest-per-bucket reduction under-reports interval deltas.
async function legacyRainDailyHistory(db, options = {}) {
  const normalizedDeveui = normalizeDeveui(options.deveui || options.deviceEui || options.device_eui);
  if (!normalizedDeveui) return [];
  const daysRaw = toFiniteNumber(options.days);
  const days = Math.max(1, Math.min(RAIN_HISTORY_MAX_DAYS, Math.round(daysRaw === null ? 7 : daysRaw)));
  const offsetRaw = toFiniteNumber(options.tzOffsetMin ?? options.tz_offset_min);
  const tzOffsetMin = Math.max(
    -RAIN_HISTORY_MAX_TZ_OFFSET_MIN,
    Math.min(RAIN_HISTORY_MAX_TZ_OFFSET_MIN, Math.round(offsetRaw === null ? 0 : offsetRaw))
  );
  const nowMs = options.nowMs ?? Date.now();
  const offsetMs = tzOffsetMin * 60 * 1000;
  // Start of the local day (days - 1) days back, converted back to UTC.
  const localTodayStartMs = Math.floor((nowMs + offsetMs) / RAIN_DAY_MS) * RAIN_DAY_MS - offsetMs;
  const start = new Date(localTodayStartMs - (days - 1) * RAIN_DAY_MS).toISOString();
  const end = new Date(nowMs).toISOString();
  const ownerFilter = optionalUserFilter(options, 'dv');
  const range = recordedAtRangeSql('dd.recorded_at', start, end, { exact: true });
  const rows = await dbAll(db, `
    SELECT
      date(dd.recorded_at, ?) AS day,
      SUM(dd.rain_mm_delta) AS total_mm,
      COUNT(*) AS samples
    FROM device_data dd
    JOIN devices dv ON dv.deveui = dd.deveui
    WHERE dd.deveui = ?
      ${ownerFilter.sql}
      AND dd.rain_mm_delta IS NOT NULL
      AND ${range.sql}
    GROUP BY day
    ORDER BY day ASC
  `, [`${tzOffsetMin} minutes`, normalizedDeveui].concat(ownerFilter.params, range.params));
  return rows.map((row) => ({
    day: String(row.day),
    total_mm: roundTo(row.total_mm, 3) ?? 0,
    samples: Number(row.samples || 0) || 0,
  }));
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  // A text cell a spreadsheet would run as a formula (=, +, -, @, tab, CR)
  // gets a leading apostrophe; numbers stay numbers.
  const stringValue = typeof value !== 'number' && /^[=+\-@\t\r]/.test(String(value)) ? `'${String(value)}` : String(value);
  return /[",\n\r]/.test(stringValue) ? '"' + stringValue.replace(/"/g, '""') + '"' : stringValue;
}

function toCsv(columns, rows) {
  const safeColumns = Array.isArray(columns) ? columns : [];
  const safeRows = Array.isArray(rows) ? rows : [];
  return [safeColumns.join(',')]
    .concat(safeRows.map((row) => safeColumns.map((column) => csvCell(row && row[column])).join(',')))
    .join('\n') + '\n';
}

const TIDY_CSV_COLUMNS = ['timestamp', 'site', 'zone', 'series_label', 'card_type', 'source_key', 'channel_key', 'depth_cm', 'array_id', 'unit', 'value'];
const RAW_CSV_COLUMNS = TIDY_CSV_COLUMNS;
const AGG_CSV_COLUMNS = TIDY_CSV_COLUMNS;

function normalizeExportDate(value, name) {
  const date = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  let canonical = null;
  if (match) {
    const year = Number(match[1]);
    const parsed = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[3])));
    parsed.setUTCFullYear(year);
    canonical = Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
  }
  if (canonical !== date) {
    const error = new Error(`${name} must be YYYY-MM-DD`);
    error.statusCode = 400;
    throw error;
  }
  return date;
}

function addIsoDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function exportSpanDays(from, to) {
  const startMs = Date.parse(`${from}T00:00:00.000Z`);
  const endMs = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  return Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
}

// Longest daily export: ten years. Daily aggregation builds a bucket for every
// day of the range per source, so an unbounded range (from=1900-01-01) could
// exhaust the gateway's heap before any row budget sees a row.
const DAILY_EXPORT_MAX_DAYS = 3660;

function assertExportRangeAllowed(scope) {
  const days = exportSpanDays(scope.from, scope.to);
  const maxDays = scope.granularity === 'raw' ? 92 : (scope.granularity === 'hourly' ? 730 : DAILY_EXPORT_MAX_DAYS);
  if (days > maxDays) {
    const error = new Error('range too large for this granularity');
    error.code = 'RANGE_TOO_LARGE';
    error.statusCode = 413;
    error.suggestion = scope.granularity === 'raw' || scope.granularity === 'hourly'
      ? 'choose a coarser granularity'
      : `choose a shorter range (at most ${DAILY_EXPORT_MAX_DAYS} days)`;
    throw error;
  }
}

function zoneDateStartIso(date, timezone) {
  let probeMs = Date.parse(`${date}T12:00:00.000Z`);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const startMs = startOfLocalDayMs(probeMs, timezone);
    const key = localDateKey(startMs, timezone);
    if (key === date) return new Date(startMs).toISOString();
    probeMs += key && key < date ? 24 * 60 * 60 * 1000 : -24 * 60 * 60 * 1000;
  }
  return new Date(startOfLocalDayMs(Date.parse(`${date}T00:00:00.000Z`), timezone)).toISOString();
}

function normalizeExportGranularity(value) {
  const granularity = String(value || 'raw').trim().toLowerCase();
  if (!['raw', 'hourly', 'daily'].includes(granularity)) {
    const error = new Error('granularity must be raw, hourly, or daily');
    error.statusCode = 400;
    throw error;
  }
  return granularity;
}

function canonicalChannelKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(LEGACY_CHANNEL_ALIASES, key)) return LEGACY_CHANNEL_ALIASES[key];
  if (VALID_EXPORT_CHANNEL_KEYS.has(key)) return key;
  const error = new Error(`unknown channel: ${key}`);
  error.statusCode = 400;
  throw error;
}

function normalizeExportChannels(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || '').split(',');
  const normalized = [];
  const seen = new Set();
  for (const value of raw) {
    const key = canonicalChannelKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }
  return normalized.length ? new Set(normalized) : null;
}

async function resolveZoneExportScope(db, options = {}) {
  const zoneId = Number(options.zoneId ?? options.zone_id);
  if (!Number.isInteger(zoneId) || zoneId <= 0) {
    const error = new Error('zoneId is required');
    error.statusCode = 400;
    throw error;
  }

  const zones = await dbAll(db, 'SELECT id, name, zone_uuid, timezone FROM irrigation_zones WHERE id = ? AND deleted_at IS NULL', [zoneId]);
  const zone = zones[0];
  if (!zone) {
    const error = new Error('zone not found');
    error.statusCode = 404;
    throw error;
  }

  const timezone = normalizeTimezone(zone.timezone);
  const from = normalizeExportDate(options.from, 'from');
  const to = normalizeExportDate(options.to || options.from, 'to');
  if (from > to) {
    const error = new Error('from must be before or equal to to');
    error.statusCode = 400;
    throw error;
  }
  const today = localDateKey(options.nowMs ?? Date.now(), timezone);
  if (!options.allowFutureDays && ((today && from > today) || (today && to > today))) {
    const error = new Error('date range cannot include future days');
    error.statusCode = 400;
    throw error;
  }

  const start = zoneDateStartIso(from, timezone);
  const end = zoneDateStartIso(addIsoDays(to, 1), timezone);
  const devices = await annotateWatermarkEvidence(db, await dbAll(db, 'SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ? ORDER BY deveui ASC', [zoneId]));
  const cards = deriveCardsForZone(zone, devices).filter((card) => normalizeCardType(card.cardType) !== 'gateway');
  const site = String(options.site || process.env.DEVICE_EUI || process.env.GATEWAY_DEVICE_EUI || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
  return { zone, timezone, from, to, start, end, devices, cards, site, requestedChannelKeys: normalizeExportChannels(options.channels), granularity: normalizeExportGranularity(options.granularity), nowMs: options.nowMs ?? Date.now() };
}

function seriesLabel(sourceName, channel) {
  return [sourceName, channel && (channel.label || channel.id)].filter(Boolean).join(' - ');
}

function sourceKeyForCsv(card, device) {
  const cardType = normalizeCardType(card && card.cardType);
  if (cardType === 'dendro') return dendroSourceKey(device && (device.deveui || device.device_eui)) || String(card && card.logicalSourceKey || '').trim();
  return displaySafeSourceKey(cardType, device) || String(card && card.logicalSourceKey || '').trim();
}

function tidyCsvRow(input) {
  const row = input || {};
  return {
    timestamp: row.timestamp ?? row.bucket_start ?? '',
    site: row.site ?? '',
    zone: row.zone ?? '',
    series_label: row.series_label ?? (row.source && (row.channel_label || row.variable) ? `${row.source} - ${row.channel_label || row.variable}` : ''),
    card_type: row.card_type ?? row.card ?? '',
    source_key: row.source_key ?? row.logical_source_key ?? '',
    channel_key: row.channel_key ?? row.variable ?? '',
    depth_cm: row.depth_cm ?? '',
    array_id: row.array_id ?? '',
    unit: row.unit ?? '',
    value: row.value ?? row.mean ?? '',
  };
}

function exportChannelsForCard(card, scope) {
  const channels = channelsForCard(card, sourceDevicesForCard(card, scope && scope.devices));
  return scope && scope.requestedChannelKeys
    ? channels.filter((channel) => scope.requestedChannelKeys.has(channel.id))
    : channels;
}

function exportChannelsForDevice(card, device, scope) {
  const channels = channelsForCard(card, [device]);
  const type = deviceTypeId(device);
  const deviceChannels = type === 'AQUASCOPE_LORAIN'
    ? channels
    : channels.filter((channel) => channel.id !== 'rain_tips_delta');
  return scope && scope.requestedChannelKeys
    ? deviceChannels.filter((channel) => scope.requestedChannelKeys.has(channel.id))
    : deviceChannels;
}

async function rawZoneExportRows(db, scope) {
  const rows = [];
  const zoneName = String(scope.zone.name || scope.zone.zone_uuid || scope.zone.id);
  for (const card of scope.cards) {
    const cardChannels = exportChannelsForCard(card, scope);
    const sourceDevices = sourceDevicesForCard(card, scope.devices)
      .slice()
      .sort((left, right) =>
        String(normalizeDeveui(left.deveui || left.device_eui) || '').localeCompare(String(normalizeDeveui(right.deveui || right.device_eui) || ''))
      );
    const deveuis = uniqueDeveuis(sourceDevices);
    if (!cardChannels.length || !deveuis.length) continue;

    const selectedFields = Array.from(new Set(cardChannels.flatMap(channelFieldNames)));
    const placeholders = deveuis.map(() => '?').join(',');
    const range = recordedAtRangeSql('recorded_at', scope.start, scope.end);
    const sql = `SELECT deveui, recorded_at, ${selectedFields.join(', ')} FROM device_data WHERE deveui IN (${placeholders}) AND ${range.sql} ORDER BY recorded_at ASC`;
    // The rows are sorted by their ISO UTC timestamp at the end.
    const dataRows = (await dbAll(db, sql, deveuis.concat(range.params)))
      .filter(recordedAtRangeFilter(scope.start, scope.end));
    const arrayIdByDeveui = await resolveDeviceArrayIds(db, deveuis, scope.start, scope.end);
    const rowsByDeveui = {};
    for (const row of dataRows) {
      const key = normalizeDeveui(row.deveui);
      if (!key) continue;
      if (!rowsByDeveui[key]) rowsByDeveui[key] = [];
      rowsByDeveui[key].push(row);
    }

    sourceDevices.forEach((device, index) => {
      const channels = exportChannelsForDevice(card, device, scope);
      if (!channels.length) return;
      const deveui = normalizeDeveui(device.deveui || device.device_eui);
      const sourceRows = rowsByDeveui[deveui] || [];
      const sourceName = displayDeviceName(device, index);
      const arrayId = arrayIdByDeveui[deveui] || null;
      for (const row of sourceRows) {
        const timestamp = canonicalRecordedAt(row.recorded_at);
        for (const channel of channels) {
          const value = channelValue(row, channel);
          if (value === null) continue;
          const csvRow = {
            timestamp,
            site: scope.site,
            zone: zoneName,
            series_label: seriesLabel(sourceName, channel),
            card_type: card.cardType,
            source_key: sourceKeyForCsv(card, device),
            channel_key: channel.id,
            depth_cm: soilDepthCm(device, channel.id),
            array_id: arrayId,
            unit: channel.unit || null,
            value: roundTo(value),
          };
          rows.push(csvRow);
          if (isSwtKpaChannel(channel)) {
            const pfRow = pfExportRow(csvRow, channel);
            if (pfRow) rows.push(pfRow);
          }
        }
        assertExportRowBudget(rows, scope);
      }
    });
  }
  rows.sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp))
    || String(left.card_type).localeCompare(String(right.card_type))
    || String(left.source_key).localeCompare(String(right.source_key))
    || String(left.channel_key).localeCompare(String(right.channel_key)));
  return rows;
}

// Local calendar months of an export range, as [start, end) instants. Hourly
// and daily buckets never cross a local midnight, so aggregating one month at
// a time gives the same buckets as one pass over the whole range, while only
// one month of raw rows per source is in memory (a raw row costs about 2.4 KB
// of heap once wrapped and sorted; ten years of 15-minute data would not fit).
function exportMonthWindows(scope) {
  const windows = [];
  const lastDay = addIsoDays(scope.to, 1);
  let day = scope.from;
  let startIso = scope.start;
  while (day < lastDay) {
    const nextMonth = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 1)).toISOString().slice(0, 10);
    const endDay = nextMonth < lastDay ? nextMonth : lastDay;
    const endIso = endDay === lastDay ? scope.end : zoneDateStartIso(endDay, scope.timezone);
    windows.push({ start: startIso, end: endIso });
    day = endDay;
    startIso = endIso;
  }
  return windows;
}

async function aggregateZoneExportRows(db, scope) {
  const rows = [];
  const zoneName = String(scope.zone.name || scope.zone.zone_uuid || scope.zone.id);
  for (const card of scope.cards) {
    const cardChannels = exportChannelsForCard(card, scope);
    const sourceDevices = sourceDevicesForCard(card, scope.devices)
      .slice()
      .sort((left, right) =>
        String(normalizeDeveui(left.deveui || left.device_eui) || '').localeCompare(String(normalizeDeveui(right.deveui || right.device_eui) || ''))
      );
    if (!cardChannels.length || !sourceDevices.length) continue;

    const arrayIdByDeveui = await resolveDeviceArrayIds(db, uniqueDeveuis(sourceDevices), scope.start, scope.end);
    let index = 0;
    for (const device of sourceDevices) {
      const channels = exportChannelsForDevice(card, device, scope);
      if (!channels.length) continue;
      const sourceName = displayDeviceName(device, index);
      index += 1;
      const deveui = normalizeDeveui(device.deveui || device.device_eui);
      if (!deveui) continue;
      for (const window of exportMonthWindows(scope)) {
        const aggregate = await aggregateDeviceData(db, {
          zoneId: scope.zone.id,
          cardType: card.cardType,
          logicalSourceKey: card.logicalSourceKey,
          device_euis: [deveui],
          sourceFilterActive: true,
          start: window.start,
          end: window.end,
          aggregation: scope.granularity,
          channels,
          timezone: scope.timezone,
          nowMs: scope.nowMs,
          useRollups: deviceTypeId(device) === 'AQUASCOPE_LORAIN' ? false : undefined,
        });
        for (const csvRow of csvRowsFromAggregate(aggregate, card, device, sourceName, channels, arrayIdByDeveui[deveui] || null, {
          site: scope.site,
          zone: zoneName,
        })) rows.push(csvRow);
        assertExportRowBudget(rows, scope);
      }
    }
  }
  rows.sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp))
    || String(left.card_type).localeCompare(String(right.card_type))
    || String(left.source_key).localeCompare(String(right.source_key))
    || String(left.channel_key).localeCompare(String(right.channel_key)));
  return rows;
}

async function buildZoneExportCsv(db, options = {}) {
  const scope = await resolveZoneExportScope(db, options);
  assertExportRangeAllowed(scope);
  if (scope.granularity === 'raw') {
    return { columns: RAW_CSV_COLUMNS, rows: await rawZoneExportRows(db, scope) };
  }
  return { columns: AGG_CSV_COLUMNS, rows: await aggregateZoneExportRows(db, scope) };
}

// Upper bound on the rows of one all-zones CSV answer. Node-RED's http response
// sends a whole string, so the answer is built in memory: at most this many
// lines of text (about 130 bytes each, so about 26 MB) plus the CSV row
// objects of the one zone being built, which the same budget caps. Past it the
// export stops and answers 413 instead of growing without limit on the
// gateway. The budget counts output rows only: the database rows one card
// (raw) or one source (hourly, daily) fetches for the range are bounded by the
// range limits of assertExportRangeAllowed, not by this budget.
const ALL_ZONES_EXPORT_MAX_ROWS = 200000;

function exportTooLarge(maxRows) {
  const error = new Error(`export exceeds ${maxRows} rows`);
  error.code = 'EXPORT_TOO_LARGE';
  error.statusCode = 413;
  error.suggestion = 'choose a shorter range, a coarser granularity, or fewer channels';
  return error;
}

function assertExportRowBudget(rows, scope) {
  if (scope && Number.isFinite(scope.rowBudget) && rows.length > scope.rowBudget) {
    throw exportTooLarge(scope.maxRows);
  }
}

// One tidy CSV over several zones (the caller passes the zones it may read).
// Each zone keeps its own local-day boundaries and its own per-source channels,
// as in the per-zone export; rows are grouped by zone (zone id order) and
// sorted within a zone as the per-zone export sorts them. Zones are built one
// at a time and turned into text at once, so only one zone's CSV row objects
// are alive at any moment (see ALL_ZONES_EXPORT_MAX_ROWS for what bounds the
// database fetch).
async function buildAllZonesExportCsv(db, options = {}) {
  const maxRows = Number.isSafeInteger(options.maxRows) && options.maxRows > 0
    ? options.maxRows
    : ALL_ZONES_EXPORT_MAX_ROWS;
  const granularity = normalizeExportGranularity(options.granularity || 'daily');
  const from = normalizeExportDate(options.from, 'from');
  const to = normalizeExportDate(options.to || options.from, 'to');
  if (from > to) {
    const error = new Error('from must be before or equal to to');
    error.statusCode = 400;
    throw error;
  }
  assertExportRangeAllowed({ from, to, granularity });
  normalizeExportChannels(options.channels);
  const zoneIds = Array.from(new Set((Array.isArray(options.zoneIds) ? options.zoneIds : [])
    .map(Number)
    .filter((zoneId) => Number.isSafeInteger(zoneId) && zoneId > 0)))
    .sort((left, right) => left - right);
  const nowMs = options.nowMs ?? Date.now();
  const zones = zoneIds.length
    ? await dbAll(db, `SELECT id, timezone FROM irrigation_zones WHERE deleted_at IS NULL AND id IN (${zoneIds.map(() => '?').join(',')}) ORDER BY id ASC`, zoneIds)
    : [];
  // A day is in the future only when it is in the future for every zone; a
  // zone still on the day before simply has no rows for it yet.
  const latestToday = zones.reduce((latest, zone) => {
    const key = localDateKey(nowMs, normalizeTimezone(zone.timezone));
    return key && (!latest || key > latest) ? key : latest;
  }, null) || localDateKey(nowMs, 'UTC');
  if (latestToday && (from > latestToday || to > latestToday)) {
    const error = new Error('date range cannot include future days');
    error.statusCode = 400;
    throw error;
  }

  const chunks = [RAW_CSV_COLUMNS.join(',') + '\n'];
  let rowCount = 0;
  for (const zone of zones) {
    const scope = await resolveZoneExportScope(db, {
      ...options, zoneId: zone.id, from, to, granularity, nowMs, allowFutureDays: true,
    });
    scope.maxRows = maxRows;
    scope.rowBudget = maxRows - rowCount;
    const rows = granularity === 'raw'
      ? await rawZoneExportRows(db, scope)
      : await aggregateZoneExportRows(db, scope);
    assertExportRowBudget(rows, scope);
    if (rows.length) {
      chunks.push(rows.map((row) => RAW_CSV_COLUMNS.map((column) => csvCell(row[column])).join(',')).join('\n') + '\n');
    }
    rowCount += rows.length;
  }
  return { columns: RAW_CSV_COLUMNS, csv: chunks.join(''), rowCount, zoneCount: zones.length };
}

async function writeZoneCsv(options = {}) {
  const fs = require('fs');
  const path = require('path');
  const zone = options.zone || {};
  const zoneUuid = String(zone.zone_uuid || zone.zoneUuid || zone.id || '').trim();
  const day = String(options.day || '').trim();
  if (!zoneUuid) throw new Error('writeZoneCsv requires zone.zone_uuid');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('writeZoneCsv requires day YYYY-MM-DD');
  const exportDir = String(options.exportDir || '/data/exports');
  const base = path.join(exportDir, zoneUuid);
  const zoneName = String(zone.name || zoneUuid);
  const stamp = (row) => tidyCsvRow({ ...(row || {}), zone: row && row.zone ? row.zone : zoneName });

  fs.mkdirSync(path.join(base, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(base, 'hourly'), { recursive: true });
  fs.writeFileSync(path.join(base, 'raw', `${day}.csv`), toCsv(RAW_CSV_COLUMNS, (options.rawRows || []).map(stamp)));
  fs.writeFileSync(path.join(base, 'hourly', `${day}.csv`), toCsv(AGG_CSV_COLUMNS, (options.hourlyRows || []).map(stamp)));

  const dailyPath = path.join(base, 'daily.csv');
  const nextDailyRows = (options.dailyRows || []).map(stamp);
  let keptLines = [];
  if (fs.existsSync(dailyPath)) {
    const lines = fs.readFileSync(dailyPath, 'utf8').split(/\r?\n/).filter((line) => line.length > 0);
    keptLines = lines.slice(1).filter((line) => !line.startsWith(day));
  }
  const dailyBody = [AGG_CSV_COLUMNS.join(',')]
    .concat(keptLines)
    .concat(nextDailyRows.map((row) => AGG_CSV_COLUMNS.map((column) => csvCell(row[column])).join(',')));
  fs.writeFileSync(dailyPath, dailyBody.join('\n') + '\n');
}

async function rotateZoneCsv(options = {}) {
  const fs = require('fs');
  const path = require('path');
  const zone = options.zone || {};
  const zoneUuid = String(zone.zone_uuid || zone.zoneUuid || zone.id || '').trim();
  if (!zoneUuid) throw new Error('rotateZoneCsv requires zone.zone_uuid');
  const exportDir = String(options.exportDir || '/data/exports');
  const retentionDays = Math.max(0, Number(options.retentionDays ?? options.retention_days ?? 90));
  const nowMs = options.nowMs ?? Date.now();
  const cutoffKey = new Date(nowMs - (retentionDays * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
  const base = path.join(exportDir, zoneUuid);
  for (const folder of ['raw', 'hourly']) {
    const dir = path.join(base, folder);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const match = /^(\d{4}-\d{2}-\d{2})\.csv$/.exec(name);
      if (match && match[1] < cutoffKey) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  }
}

async function buildZoneCsvRows(db, zone, day, nowMs) {
  const scope = await resolveZoneExportScope(db, {
    zoneId: zone.id,
    from: day,
    to: day,
    nowMs,
  });
  return {
    rawRows: await rawZoneExportRows(db, { ...scope, granularity: 'raw' }),
    hourlyRows: await aggregateZoneExportRows(db, { ...scope, granularity: 'hourly' }),
    dailyRows: await aggregateZoneExportRows(db, { ...scope, granularity: 'daily' }),
  };
}

async function runRollupJob(db, options = {}) {
  const startedAt = Date.now();
  const nowMs = options.nowMs ?? Date.now();
  const exportDir = options.exportDir === undefined ? '/data/exports' : options.exportDir;
  const retentionDays = Number(options.retentionDays ?? options.retention_days ?? process.env.HISTORY_CSV_RAW_RETENTION_DAYS ?? 90) || 90;
  const levels = Array.isArray(options.levels) && options.levels.length
    ? options.levels.filter((level) => Object.prototype.hasOwnProperty.call(ROLLUP_WINDOWS, level))
    : ['hourly', 'daily', 'weekly'];
  const zones = await dbAll(db, 'SELECT id, name, zone_uuid, timezone FROM irrigation_zones WHERE deleted_at IS NULL', []);
  let cardsProcessed = 0;
  let bucketsUpserted = 0;
  let csvZonesWritten = 0;
  let csvRowsWritten = 0;
  const errors = [];

  for (const zone of zones) {
    try {
      const devices = await annotateWatermarkEvidence(db, await dbAll(db, 'SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ?', [zone.id]));
      const cards = deriveCardsForZone(zone, devices);
      for (const card of cards) {
        const sourceDevices = sourceDevicesForCard(card, devices);
        const channels = channelsForCard(card, sourceDevices);
        const deveuis = uniqueDeveuis(sourceDevices);
        if (!channels.length || !deveuis.length) continue;
        cardsProcessed += 1;
        const scope = {
          zoneId: zone.id,
          cardType: card.cardType,
          logicalSourceKey: card.logicalSourceKey,
          channels,
          deveuis,
          sourceDevices,
          timezone: zone.timezone || 'UTC',
        };
        for (const level of levels) {
          const rows = await computeRollupBuckets(db, scope, level, ROLLUP_WINDOWS[level], nowMs);
          bucketsUpserted += await upsertRollups(db, rows);
        }
      }
      if (exportDir) {
        const timezone = zone.timezone || 'UTC';
        const dayEndMs = startOfLocalDayMs(nowMs, timezone);
        const dayStartMs = dayEndMs - (24 * 60 * 60 * 1000);
        const day = localDateKey(dayStartMs, timezone);
        const csvRows = await buildZoneCsvRows(db, zone, day, dayEndMs);
        await writeZoneCsv({ exportDir, zone, day, rawRows: csvRows.rawRows, hourlyRows: csvRows.hourlyRows, dailyRows: csvRows.dailyRows });
        await rotateZoneCsv({ exportDir, zone, nowMs, retentionDays });
        csvZonesWritten += 1;
        csvRowsWritten += csvRows.rawRows.length + csvRows.hourlyRows.length + csvRows.dailyRows.length;
      }
    } catch (error) {
      errors.push({ zoneId: zone.id, message: String(error && error.message || error) });
    }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    zones: zones.length,
    cardsProcessed,
    bucketsUpserted,
    csvZonesWritten,
    csvRowsWritten,
    errors,
    durationMs: Date.now() - startedAt,
  };
}

function parseDepthJson(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {
    return null;
  }
  return null;
}

function soilDepthCm(device, channelId) {
  if (channelId === 'swt_3' && !isLsn50Swt3Eligible(device)) {
    return null;
  }
  const direct = {
    swt_1: device && device.chameleon_swt1_depth_cm,
    swt_2: device && device.chameleon_swt2_depth_cm,
    swt_3: device && device.chameleon_swt3_depth_cm,
  }[channelId];
  const directNumber = toFiniteNumber(direct);
  if (directNumber !== null) return directNumber;
  const configured = parseDepthJson(device && device.soil_moisture_probe_depths_json);
  if (Array.isArray(configured)) {
    const index = { swt_1: 0, swt_2: 1, swt_3: 2, swt_wm1: 0, swt_wm2: 1 }[channelId];
    return index === undefined ? null : toFiniteNumber(configured[index]);
  }
  if (configured && typeof configured === 'object') {
    return toFiniteNumber(configured[channelId] ?? configured[channelId.replace('_', '')] ?? configured[channelId.toUpperCase()]);
  }
  return null;
}

async function resolveDeviceArrayIds(db, deveuis, start, end) {
  const map = {};
  const list = Array.from(new Set((deveuis || []).map((value) => normalizeDeveui(value)).filter(Boolean)));
  if (!list.length) return map;
  const placeholders = list.map(() => '?').join(',');
  const sql = `SELECT deveui, array_id, MAX(recorded_at) AS latest FROM chameleon_readings WHERE deveui IN (${placeholders}) AND array_id IS NOT NULL AND recorded_at >= ? AND recorded_at < ? GROUP BY deveui`;
  let rows = [];
  try {
    rows = await dbAll(db, sql, list.concat([start, end]));
  } catch (_) {
    return map;
  }
  for (const row of rows || []) {
    const key = normalizeDeveui(row.deveui);
    if (key && row.array_id != null && row.array_id !== '') map[key] = String(row.array_id);
  }
  return map;
}

function csvRowsFromAggregate(aggregate, card, device, sourceName, channels, arrayId, context = {}) {
  const rows = [];
  const isLoRain = deviceTypeId(device) === 'AQUASCOPE_LORAIN';
  const valueForChannel = (stats, channel) => {
    if (!isLoRain) return stats.mean;
    if (channel.id === 'rain_mm_delta' || channel.id === 'rain_tips_delta') return stats.sum;
    if (channel.id === 'rain_mm_today') return stats.latest;
    return stats.mean;
  };
  for (const bucket of aggregate.buckets || []) {
    for (const channel of channels) {
      const stats = bucket.series && bucket.series[channel.id];
      if (!stats || Number(stats.sampleCount || 0) === 0) continue;
      const csvRow = {
        timestamp: bucket.bucketStart,
        site: context.site || '',
        zone: context.zone || '',
        series_label: seriesLabel(sourceName, channel),
        card_type: card.cardType,
        source_key: sourceKeyForCsv(card, device),
        channel_key: channel.id,
        depth_cm: soilDepthCm(device, channel.id),
        array_id: arrayId == null ? null : arrayId,
        unit: channel.unit || stats.unit || null,
        value: valueForChannel(stats, channel),
      };
      rows.push(csvRow);
      if (isSwtKpaChannel(channel)) {
        const pfRow = pfExportRow(csvRow, channel);
        if (pfRow) rows.push(pfRow);
      }
    }
  }
  return rows;
}

function hoursBetween(start, end) {
  const startMs = parseTime(start);
  const endMs = parseTime(end);
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return Math.round((endMs - startMs) / (60 * 60 * 1000));
}

function buildLocalInterpretations(input = {}) {
  const generatedAt = input.generatedAt || new Date(0).toISOString();
  const coveragePct = toFiniteNumber(input.coveragePct);
  const coverageConfidence = input.coverageConfidence || 'unknown';
  const items = [];

  if (normalizeCardType(input.cardType) === 'soil' && input.status === 'dry_stress') {
    items.push({
      ruleId: 'root-zone-dry',
      severity: 'warning',
      titleKey: 'history.interpretation.rootZoneDry.title',
      bodyKey: 'history.interpretation.rootZoneDry.body',
      params: { hoursDry: hoursBetween(input.statusSince, generatedAt) },
      evidence: [{ type: 'status', status: 'dry_stress', since: input.statusSince || null }],
      source: 'local-rule',
    });
  }

  const generatedMs = parseTime(generatedAt);
  const rangeFromMs = parseTime(input.rangeFrom);
  // Fully-future windows have nothing to be missing yet; coverage is null
  // there and must not trigger the unknown-confidence info banner either.
  const fullyFutureWindow = rangeFromMs !== null && generatedMs !== null && rangeFromMs >= generatedMs;
  if (!fullyFutureWindow && (coverageConfidence === 'unknown' || (coveragePct !== null && coveragePct < 80))) {
    items.push({
      ruleId: 'data-coverage-gap',
      severity: coverageConfidence === 'unknown' ? 'info' : 'warning',
      titleKey: 'history.interpretation.dataCoverageGap.title',
      bodyKey: 'history.interpretation.dataCoverageGap.body',
      params: { coveragePct, coverageConfidence },
      evidence: [{ type: 'coverage', coveragePct, coverageConfidence }],
      source: 'local-rule',
    });
  }

  if (input.status === 'incomplete_night_recovery' || input.dendroStatus === 'incomplete_night_recovery') {
    items.push({
      ruleId: 'incomplete-night-recovery',
      severity: 'warning',
      titleKey: 'history.interpretation.incompleteNightRecovery.title',
      bodyKey: 'history.interpretation.incompleteNightRecovery.body',
      params: { recoveryRatio: toFiniteNumber(input.recoveryRatio) },
      evidence: [{ type: 'dendro_status', status: 'incomplete_night_recovery' }],
      source: 'local-rule',
    });
  }

  return items;
}

// One Intl.DateTimeFormat per distinct timezone string, kept for the life of
// the process: aggregationBuckets and zoneDateStartIso call normalizeTimezone/
// localDateKey/startOfLocalDayMs once per bucket, and a fresh formatter per
// call was most of the cost of a multi-hundred-bucket weather request (final
// review I3). The cache is a pure function of the timezone string, so keeping
// it past one call chain only saves more repeats; it never observes rows.
const ZONE_FORMATTER_CACHE = new Map();
function zoneFormatterEntry(value) {
  const raw = String(value || 'UTC').trim() || 'UTC';
  const cached = ZONE_FORMATTER_CACHE.get(raw);
  if (cached) return cached;
  const dateTimeOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  };
  const dateOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
  let entry;
  try {
    entry = {
      timezone: raw,
      dateTimeFormat: new Intl.DateTimeFormat('en-US', { ...dateTimeOptions, timeZone: raw }),
      dateFormat: new Intl.DateTimeFormat('en-US', { ...dateOptions, timeZone: raw }),
    };
  } catch (_) {
    entry = {
      timezone: 'UTC',
      dateTimeFormat: new Intl.DateTimeFormat('en-US', { ...dateTimeOptions, timeZone: 'UTC' }),
      dateFormat: new Intl.DateTimeFormat('en-US', { ...dateOptions, timeZone: 'UTC' }),
    };
  }
  ZONE_FORMATTER_CACHE.set(raw, entry);
  return entry;
}

function partsOf(formatter, ms) {
  const acc = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') acc[part.type] = part.value;
  }
  return acc;
}

function normalizeTimezone(value) {
  return zoneFormatterEntry(value).timezone;
}

function startOfLocalDayMs(nowMs, timezone) {
  const instantMs = typeof nowMs === 'number' ? nowMs : parseTime(nowMs);
  if (instantMs === null) throw new Error('startOfLocalDayMs requires a valid instant');
  const { dateTimeFormat } = zoneFormatterEntry(timezone);
  const parts = partsOf(dateTimeFormat, instantMs);
  const targetWallClockMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    0,
    0,
    0
  );
  let candidateMs = targetWallClockMs;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidateParts = partsOf(dateTimeFormat, candidateMs);
    const candidateWallClockMs = Date.UTC(
      Number(candidateParts.year),
      Number(candidateParts.month) - 1,
      Number(candidateParts.day),
      Number(candidateParts.hour) % 24,
      Number(candidateParts.minute),
      Number(candidateParts.second)
    );
    const deltaMs = candidateWallClockMs - targetWallClockMs;
    if (deltaMs === 0) return candidateMs;
    candidateMs -= deltaMs;
  }
  return candidateMs;
}

function localDateKey(value, timezone) {
  const ms = typeof value === 'number' ? value : parseTime(value);
  if (ms === null) return null;
  const { dateFormat } = zoneFormatterEntry(timezone);
  const values = partsOf(dateFormat, ms);
  return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : null;
}

function dateKeyToUtcMs(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addUtcDays(dateKey, days) {
  const ms = dateKeyToUtcMs(dateKey);
  if (ms === null) return null;
  return new Date(ms + (days * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function calendarRangeDateKeys(input, timezone, observedKeys) {
  const range = input.range || {};
  const from = parseTime(range.from || input.from || input.start || input.startAt);
  const to = parseTime(range.to || input.to || input.end || input.endAt);
  if (from !== null && to !== null && to > from) {
    const startKey = localDateKey(from, timezone);
    const endKey = localDateKey(to - 1, timezone);
    if (startKey && endKey) {
      const keys = [];
      for (let key = startKey; key && key <= endKey; key = addUtcDays(key, 1)) {
        keys.push(key);
        if (key === endKey) break;
      }
      return keys;
    }
  }
  return Array.from(observedKeys).sort();
}

function calendarCoverageForDate(input, dateKey, rows) {
  const byDate = input.coverageByDate || input.coverage_by_date || {};
  const configured = byDate[dateKey];
  if (configured && typeof configured === 'object') {
    return {
      coveragePct: configured.coveragePct ?? configured.coverage_pct ?? null,
      coverageConfidence: configured.coverageConfidence || configured.coverage_confidence || 'unknown',
    };
  }
  const values = rows
    .map((row) => toFiniteNumber(row.coveragePct ?? row.coverage_pct))
    .filter((value) => value !== null);
  return {
    coveragePct: values.length ? roundTo(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    coverageConfidence: values.length ? 'derived' : 'unknown',
  };
}

function priorityStatus(statuses, priority, fallback) {
  const present = new Set(statuses.filter((status) => status && status !== 'no_data'));
  if (present.size === 0) return fallback;
  for (const status of priority) {
    if (present.has(status)) return status;
  }
  return Array.from(present)[0] || fallback;
}

function classifySoilDay(rows) {
  const values = rows
    .map((row) => classifySoilStatus(row).value)
    .filter((value) => value !== null);
  if (values.length === 0) return 'no_data';
  return classifySoilStatus({ value: values.reduce((sum, value) => sum + value, 0) / values.length }).status;
}

function soilDayStatuses(rows) {
  return Array.from(new Set(rows.map((row) => classifySoilStatus(row).status).filter((status) => status && status !== 'no_data')));
}

function dendroDayStatuses(rows) {
  return Array.from(new Set(rows.map((row) => classifyDendroStatus({
    recoveryRatio: row.recoveryRatio ?? row.recovery_ratio ?? row.dendro_ratio,
    mdsUm: row.mdsUm ?? row.mds_um,
    growthUm: row.growthUm ?? row.growth_um ?? row.dendro_stem_change_um,
  }).status).filter((status) => status && status !== 'no_data')));
}

function environmentDayStatuses(rows) {
  return Array.from(new Set(rows.map((row) => classifyEnvironmentStatus(row).status).filter((status) => status && status !== 'no_data')));
}

function classifyDendroDay(rows) {
  return priorityStatus(
    rows.map((row) => classifyDendroStatus({
      recoveryRatio: row.recoveryRatio ?? row.recovery_ratio ?? row.dendro_ratio,
      mdsUm: row.mdsUm ?? row.mds_um,
      growthUm: row.growthUm ?? row.growth_um ?? row.dendro_stem_change_um,
    }).status),
    ['incomplete_night_recovery', 'high_shrinkage_stress', 'reduced_growth', 'normal_growth'],
    'no_data'
  );
}

function classifyEnvironmentDay(rows) {
  return priorityStatus(
    rows.map((row) => classifyEnvironmentStatus(row).status),
    ['heat_stress', 'cold_stress', 'high_humidity', 'rain_day', 'normal'],
    'no_data'
  );
}

function eventHasType(event, pattern) {
  return pattern.test(String(event.type || event.action || event.reason || '').trim());
}

function classifyIrrigationDay(events) {
  if (events.some((event) => event.manualOverride === true || event.manual_override === true || eventHasType(event, /manual|override/i))) {
    return 'manual_override';
  }
  if (events.some((event) => event.possibleIneffectiveIrrigation === true || event.possible_ineffective_irrigation === true || eventHasType(event, /ineffective/i))) {
    return 'possible_ineffective_irrigation';
  }
  return classifyIrrigationStatus({ eventCount: events.length }).status;
}

function classifyGatewayDay(rows, generatedAt) {
  const sorted = rows
    .map((row) => row.lastSeenAt || row.last_seen_at || row.recorded_at || row.recordedAt)
    .filter(Boolean)
    .sort();
  return classifyGatewayStatus({
    generatedAt,
    lastSeenAt: sorted.length ? sorted[sorted.length - 1] : null,
  }).status;
}

function markerSeverityForStatus(status) {
  if ([
    'dry_stress',
    'wet_excess',
    'high_shrinkage_stress',
    'incomplete_night_recovery',
    'heat_stress',
    'cold_stress',
    'high_irrigation_frequency',
    'possible_ineffective_irrigation',
    'offline',
  ].includes(status)) return 'warning';
  if (status === 'no_data') return 'unknown';
  return 'info';
}

function buildCalendar(input = {}) {
  const cardType = normalizeCardType(input.cardType || input.card_type) || 'soil';
  const timezone = normalizeTimezone(input.timezone || (input.range && input.range.timezone));
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const events = Array.isArray(input.events) ? input.events : [];
  const observedKeys = new Set();
  const rowsByDate = {};
  const eventsByDate = {};

  for (const row of rows) {
    const key = localDateKey(row.recorded_at || row.recordedAt || row.bucket_start || row.t, timezone);
    if (!key) continue;
    observedKeys.add(key);
    if (!rowsByDate[key]) rowsByDate[key] = [];
    rowsByDate[key].push(row);
  }
  for (const event of events) {
    const key = localDateKey(event.t || event.created_at || event.createdAt || event.recorded_at, timezone);
    if (!key) continue;
    observedKeys.add(key);
    if (!eventsByDate[key]) eventsByDate[key] = [];
    eventsByDate[key].push(event);
  }

  const days = calendarRangeDateKeys(input, timezone, observedKeys).map((date) => {
    const dayRows = rowsByDate[date] || [];
    const dayEvents = eventsByDate[date] || [];
    let state = 'no_data';
    if (cardType === 'soil') state = classifySoilDay(dayRows);
    else if (cardType === 'dendro') state = classifyDendroDay(dayRows);
    else if (cardType === 'environment') state = classifyEnvironmentDay(dayRows);
    else if (cardType === 'irrigation') state = classifyIrrigationDay(dayEvents);
    else if (cardType === 'gateway') state = classifyGatewayDay(dayRows, input.generatedAt || input.generated_at || new Date(0).toISOString());

    const coverage = calendarCoverageForDate(input, date, dayRows);
    const sampleCount = dayRows.length;
    const eventCount = dayEvents.length;
    let markerStates = state === 'no_data' ? [] : [state];
    if (cardType === 'dendro') markerStates = dendroDayStatuses(dayRows);
    else if (cardType === 'environment') markerStates = environmentDayStatuses(dayRows);
    return {
      date,
      state,
      coveragePct: coverage.coveragePct,
      coverageConfidence: coverage.coverageConfidence,
      summary: {
        key: `history.calendar.summary.${cardType}.${state}`,
        params: { sampleCount, eventCount },
      },
      metrics: {
        sampleCount,
        eventCount,
      },
      markers: markerStates.map((markerState) => ({
        type: 'state',
        severity: markerSeverityForStatus(markerState),
        labelKey: `history.calendar.marker.${cardType}.${markerState}`,
        params: { sampleCount, eventCount },
      })),
    };
  });

  return { timezone, days };
}

function advancedField(name, value, unit, availability) {
  return {
    field: name,
    value: value === undefined ? null : value,
    unit: unit === undefined ? null : unit,
    availability,
  };
}

function rowHasOwn(row, keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(row || {}, key));
}

function latestRowValue(latestRow, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(latestRow || {}, key)) return latestRow[key];
  }
  return undefined;
}

function diagnosticAvailability(input, latestRow, keys, supported = true) {
  if (!supported) return 'unsupported';
  const collected = new Set((Array.isArray(input.collectedFields) ? input.collectedFields : input.collected_fields || []).map(String));
  if (keys.some((key) => collected.has(key))) return 'collected';
  const value = latestRowValue(latestRow, keys);
  if (value !== undefined && value !== null) return 'collected';
  if (latestRow && keys.some((key) => rowHasOwn(latestRow, [key]))) return 'not_collected_at_time';
  if ((Array.isArray(input.latestRows) ? input.latestRows : []).length > 0) return 'not_collected_at_time';
  return 'unknown_now';
}

function buildAdvancedDiagnostics(input = {}) {
  const cardType = normalizeCardType(input.cardType || input.card_type) || 'unknown';
  const latestRows = Array.isArray(input.latestRows) ? input.latestRows : [];
  const latestRow = latestRows.slice().sort((left, right) =>
    (parseTime(right.recorded_at || right.recordedAt) || 0) - (parseTime(left.recorded_at || left.recordedAt) || 0)
  )[0] || null;
  const sourceDevices = Array.isArray(input.sourceDevices) ? input.sourceDevices : [];
  const sourceDevice = sourceDevices[0] || null;
  const availableFields = new Set();
  for (const row of latestRows) {
    for (const key of Object.keys(row || {})) {
      if (row[key] !== undefined && row[key] !== null) availableFields.add(key);
    }
  }
  const calibrationStatus = input.calibrationStatus ?? input.calibration_status ?? null;
  const pendingCommandCount = input.pendingCommandCount ?? input.pending_command_count;
  const gatewayEui = normalizeDeveui(input.gatewayEui || input.gateway_eui);
  const primaryDeveui = sourceDevice ? normalizeDeveui(sourceDevice.deveui || sourceDevice.device_eui || sourceDevice.deviceEui) : null;
  const fields = {
    sourceDeviceCount: advancedField('sourceDeviceCount', sourceDevices.length, null, 'collected'),
    logicalSourceKey: advancedField('logicalSourceKey', input.logicalSourceKey || input.logical_source_key || null, null, input.logicalSourceKey || input.logical_source_key ? 'collected' : 'unsupported'),
    primaryDeveui: advancedField('primaryDeveui', primaryDeveui, null, primaryDeveui ? 'collected' : 'unknown_now'),
    gatewayEui: advancedField('gatewayEui', gatewayEui, null, gatewayEui ? 'collected' : 'unknown_now'),
    rawRowCount: advancedField('rawRowCount', toFiniteNumber(input.rowCount ?? input.row_count) || 0, null, toFiniteNumber(input.rowCount ?? input.row_count) > 0 ? 'collected' : 'not_collected_at_time'),
    rssi: advancedField('rssi', latestRowValue(latestRow, ['rssi']), 'dBm', diagnosticAvailability(input, latestRow, ['rssi'])),
    snr: advancedField('snr', latestRowValue(latestRow, ['snr']), 'dB', diagnosticAvailability(input, latestRow, ['snr'])),
    batteryVoltage: advancedField('batteryVoltage', latestRowValue(latestRow, ['bat_v', 'battery_voltage']), 'V', diagnosticAvailability(input, latestRow, ['bat_v', 'battery_voltage'])),
    batteryPct: advancedField('batteryPct', latestRowValue(latestRow, ['bat_pct', 'battery_pct']), '%', diagnosticAvailability(input, latestRow, ['bat_pct', 'battery_pct'])),
    firmwareVersion: advancedField('firmwareVersion', sourceDevice && (sourceDevice.firmware_version || sourceDevice.firmwareVersion) || null, null, sourceDevice && (sourceDevice.firmware_version || sourceDevice.firmwareVersion) ? 'collected' : 'unknown_now'),
    rawPayload: advancedField('rawPayload', latestRowValue(latestRow, ['raw_payload', 'payload_raw']), null, diagnosticAvailability(input, latestRow, ['raw_payload', 'payload_raw'])),
    pendingCommands: advancedField('pendingCommands', pendingCommandCount === undefined ? null : pendingCommandCount, null, cardType === 'gateway' ? (pendingCommandCount === null || pendingCommandCount === undefined ? 'unknown_now' : 'collected') : 'unsupported'),
    calibrationStatus: advancedField('calibrationStatus', calibrationStatus, null, cardType === 'soil' ? (calibrationStatus ? 'collected' : 'unknown_now') : 'unsupported'),
  };
  const placeholder = buildAdvancedMetadataPlaceholder({
    cardType,
    generatedAt: input.generatedAt || input.generated_at,
    sourceDevices,
    availableFields: Array.from(availableFields).sort(),
  });
  return { schemaVersion: 1, placeholder, fields };
}

function buildAdvancedMetadataPlaceholder(input = {}) {
  const cardType = normalizeCardType(input.cardType || input.card_type) || 'unknown';
  const sourceDevices = (Array.isArray(input.sourceDevices) ? input.sourceDevices : [])
    .map((device) => ({
      deveui: normalizeDeveui(device.deveui || device.device_eui || device.deviceEui),
      typeId: String(device.type_id || device.typeId || device.type || '').trim().toUpperCase() || null,
      name: device.name ? String(device.name) : null,
      firmwareVersion: device.firmware_version || device.firmwareVersion || null,
    }))
    .filter((device) => device.deveui)
    .sort((left, right) => left.deveui.localeCompare(right.deveui));
  const availableFields = (Array.isArray(input.availableFields) ? input.availableFields : [])
    .map((field) => String(field || '').trim())
    .filter(Boolean)
    .sort();

  return {
    schemaVersion: 1,
    cardType,
    placeholder: true,
    generatedAt: input.generatedAt || input.generated_at || new Date(0).toISOString(),
    availableFields,
    sourceDevices,
    sections: [
      { id: 'source-devices', status: sourceDevices.length ? 'available' : 'not_available', itemCount: sourceDevices.length },
      { id: 'radio-diagnostics', status: availableFields.some((field) => ['rssi', 'snr'].includes(field)) ? 'partial' : 'not_available' },
      { id: 'raw-payloads', status: availableFields.includes('raw_payload') ? 'partial' : 'not_available' },
    ],
  };
}

const analysis = createAnalysis({
  aggregateRows,
  annotateWatermarkEvidence,
  dbAll,
  deriveCardsForZone,
  displayDeviceName,
  localDateKey,
  normalizeDeveui,
  normalizeTimezone,
  parseRecordedAtMs,
  recordedAtRangeSql,
  resolveAggregation,
  soilDepthCm,
  sourceDevicesForCard,
  sourceKeyForCsv,
  deviceSourceId,
  describeDeviceSource,
  filterSoilRowsForSources,
  zoneDateStartIso,
  zoneLocations,
});

module.exports = {
  normalizeDeveui,
  parseRecordedAtMs,
  ANALYSIS_VIEWS_SCHEMA: analysis.ANALYSIS_VIEWS_SCHEMA,
  analysisSeriesId: analysis.analysisSeriesId,
  buildAnalysisCatalog: analysis.buildAnalysisCatalog,
  deviceSourceId,
  describeDeviceSource,
  listAnalysisViews: analysis.listAnalysisViews,
  resolveAnalysisSeries: analysis.resolveAnalysisSeries,
  saveAnalysisView: analysis.saveAnalysisView,
  deleteAnalysisView: analysis.deleteAnalysisView,
  deriveCardId,
  deriveCardsForZone,
  deriveGatewayCard,
  resolveAggregation,
  kpaToPf,
  classifySoilStatus,
  classifySoilDay,
  classifyEnvironmentStatus,
  classifyDendroStatus,
  classifyIrrigationStatus,
  classifyGatewayStatus,
  deriveExpectedCadenceSeconds,
  legacySensorHistory,
  legacyRainDailyHistory,
  resolveDeviceTimezones,
  resolveDeviceTimezone,
  resolveDeviceFieldRollupKey,
  runRollupJob,
  upsertRollups,
  computeRollupBuckets,
  rollupRowsToResult,
  startOfLocalDayMs,
  buildZoneExportCsv,
  buildAllZonesExportCsv,
  ALL_ZONES_EXPORT_MAX_ROWS,
  RAW_CSV_COLUMNS,
  AGG_CSV_COLUMNS,
  toCsv,
  writeZoneCsv,
  rotateZoneCsv,
  aggregateRows,
  soilDepthCm,
  filterSoilChannelsForSources,
  filterSoilRowsForSources,
  isSoilSource,
  isEnvironmentSource,
  isWatermarkNode,
  annotateWatermarkEvidence,
  isLsn50Swt3Eligible,
  aggregateDeviceData,
  buildAdvancedMetadataPlaceholder,
  buildAdvancedDiagnostics,
  buildCalendar,
  buildLocalInterpretations,
};
