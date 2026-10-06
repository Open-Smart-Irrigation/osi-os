'use strict';

const crypto = require('crypto');
const { SOURCE_KINDS, providerSourceName, createWeatherSources } = require('./analysis-sources');

const CHANNELS = [
  { key: 'swt_1', unit: 'kPa', label: 'Soil tension 1', cardType: 'soil', edgeField: 'swt_1', exportable: true, deprecated: false },
  { key: 'swt_2', unit: 'kPa', label: 'Soil tension 2', cardType: 'soil', edgeField: 'swt_2', exportable: true, deprecated: false },
  { key: 'swt_3', unit: 'kPa', label: 'Soil tension (S3)', cardType: 'soil', edgeField: 'swt_3', exportable: true, deprecated: false },
  { key: 'vwc_1', unit: '%', label: 'VWC 1', cardType: 'soil', edgeField: 'vwc_1', exportable: true, deprecated: false },
  { key: 'vwc_2', unit: '%', label: 'VWC 2', cardType: 'soil', edgeField: 'vwc_2', exportable: true, deprecated: false },
  { key: 'vwc_3', unit: '%', label: 'VWC 3', cardType: 'soil', edgeField: 'vwc_3', exportable: true, deprecated: false },
  { key: 'vwc_4', unit: '%', label: 'VWC 4', cardType: 'soil', edgeField: 'vwc_4', exportable: true, deprecated: false },
  { key: 'vwc_5', unit: '%', label: 'VWC 5', cardType: 'soil', edgeField: 'vwc_5', exportable: true, deprecated: false },
  { key: 'vwc_6', unit: '%', label: 'VWC 6', cardType: 'soil', edgeField: 'vwc_6', exportable: true, deprecated: false },
  { key: 'vwc_7', unit: '%', label: 'VWC 7', cardType: 'soil', edgeField: 'vwc_7', exportable: true, deprecated: false },
  { key: 'vwc_8', unit: '%', label: 'VWC 8', cardType: 'soil', edgeField: 'vwc_8', exportable: true, deprecated: false },
  { key: 'vwc_9', unit: '%', label: 'VWC 9', cardType: 'soil', edgeField: 'vwc_9', exportable: true, deprecated: false },
  { key: 'vwc_10', unit: '%', label: 'VWC 10', cardType: 'soil', edgeField: 'vwc_10', exportable: true, deprecated: false },
  ...Array.from({ length: 10 }, (_, i) => ({ key: `soil_vic_${i + 1}`, unit: '', label: `VIC ${i + 1}`, cardType: 'soil', edgeField: `soil_vic_${i + 1}`, exportable: true, deprecated: false })),
  { key: 'soil_temp_1', unit: '°C', label: 'Soil temp 1', cardType: 'soil', edgeField: 'soil_temp_1', exportable: true, deprecated: false },
  { key: 'soil_temp_2', unit: '°C', label: 'Soil temp 2', cardType: 'soil', edgeField: 'soil_temp_2', exportable: true, deprecated: false },
  { key: 'soil_temp_3', unit: '°C', label: 'Soil temp 3', cardType: 'soil', edgeField: 'soil_temp_3', exportable: true, deprecated: false },
  { key: 'soil_temp_4', unit: '°C', label: 'Soil temp 4', cardType: 'soil', edgeField: 'soil_temp_4', exportable: true, deprecated: false },
  { key: 'soil_temp_5', unit: '°C', label: 'Soil temp 5', cardType: 'soil', edgeField: 'soil_temp_5', exportable: true, deprecated: false },
  { key: 'soil_temp_6', unit: '°C', label: 'Soil temp 6', cardType: 'soil', edgeField: 'soil_temp_6', exportable: true, deprecated: false },
  { key: 'soil_temp_7', unit: '°C', label: 'Soil temp 7', cardType: 'soil', edgeField: 'soil_temp_7', exportable: true, deprecated: false },
  { key: 'soil_temp_8', unit: '°C', label: 'Soil temp 8', cardType: 'soil', edgeField: 'soil_temp_8', exportable: true, deprecated: false },
  { key: 'soil_ec_1', unit: 'µS/cm', label: 'Soil EC 1', cardType: 'soil', edgeField: 'soil_ec_1', exportable: true, deprecated: false },
  { key: 'soil_ec_2', unit: 'µS/cm', label: 'Soil EC 2', cardType: 'soil', edgeField: 'soil_ec_2', exportable: true, deprecated: false },
  { key: 'soil_ec_3', unit: 'µS/cm', label: 'Soil EC 3', cardType: 'soil', edgeField: 'soil_ec_3', exportable: true, deprecated: false },
  { key: 'soil_ec_4', unit: 'µS/cm', label: 'Soil EC 4', cardType: 'soil', edgeField: 'soil_ec_4', exportable: true, deprecated: false },
  { key: 'soil_ec_5', unit: 'µS/cm', label: 'Soil EC 5', cardType: 'soil', edgeField: 'soil_ec_5', exportable: true, deprecated: false },
  { key: 'soil_ec_6', unit: 'µS/cm', label: 'Soil EC 6', cardType: 'soil', edgeField: 'soil_ec_6', exportable: true, deprecated: false },
  { key: 'soil_ec_7', unit: 'µS/cm', label: 'Soil EC 7', cardType: 'soil', edgeField: 'soil_ec_7', exportable: true, deprecated: false },
  { key: 'soil_ec_8', unit: 'µS/cm', label: 'Soil EC 8', cardType: 'soil', edgeField: 'soil_ec_8', exportable: true, deprecated: false },
  { key: 'vwc', unit: '%', label: 'VWC', cardType: 'soil', edgeField: null, exportable: true, deprecated: false },
  { key: 'ambient_temperature', unit: '°C', label: 'Ambient temperature', cardType: 'environment', edgeField: 'ambient_temperature', exportable: true, deprecated: false },
  { key: 'relative_humidity', unit: '%', label: 'Relative humidity', cardType: 'environment', edgeField: 'relative_humidity', exportable: true, deprecated: false },
  { key: 'light_lux', unit: 'lux', label: 'Light', cardType: 'environment', edgeField: 'light_lux', exportable: true, deprecated: false },
  { key: 'ext_temperature_c', unit: '°C', label: 'External temperature', cardType: 'environment', edgeField: 'ext_temperature_c', exportable: true, deprecated: false },
  { key: 'rain_mm_per_hour', unit: 'mm/h', label: 'Rain rate', cardType: 'environment', edgeField: 'rain_mm_per_hour', exportable: true, deprecated: false },
  { key: 'rain_mm_per_10min', unit: 'mm/10min', label: 'Rain (10 min)', cardType: 'environment', edgeField: 'rain_mm_per_10min', exportable: true, deprecated: false },
  { key: 'rain_mm_today', unit: 'mm', label: 'Rain today', cardType: 'environment', edgeField: 'rain_mm_today', exportable: true, deprecated: false },
  { key: 'rain_mm_delta', unit: 'mm', label: 'Rain delta', cardType: 'environment', edgeField: 'rain_mm_delta', exportable: true, deprecated: false },
  { key: 'wind_speed_mps', unit: 'm/s', label: 'Wind speed', cardType: 'environment', edgeField: 'wind_speed_mps', exportable: true, deprecated: false },
  { key: 'wind_gust_mps', unit: 'm/s', label: 'Wind gust', cardType: 'environment', edgeField: 'wind_gust_mps', exportable: true, deprecated: false },
  { key: 'barometric_pressure_hpa', unit: 'hPa', label: 'Pressure', cardType: 'environment', edgeField: 'barometric_pressure_hpa', exportable: true, deprecated: false },
  { key: 'uv_index', unit: null, label: 'UV index', cardType: 'environment', edgeField: 'uv_index', exportable: true, deprecated: false },
  { key: 'dendro_stem_change_um', unit: 'µm', label: 'Stem change', cardType: 'dendro', edgeField: 'dendro_stem_change_um', exportable: true, deprecated: false },
  { key: 'dendro_position_mm', unit: 'mm', label: 'Position', cardType: 'dendro', edgeField: 'dendro_position_mm', exportable: true, deprecated: false },
  { key: 'dendro_position_raw_mm', unit: 'mm', label: 'Position (raw)', cardType: 'dendro', edgeField: 'dendro_position_raw_mm', exportable: true, deprecated: false },
  { key: 'dendro_delta_mm', unit: 'mm', label: 'Delta', cardType: 'dendro', edgeField: 'dendro_delta_mm', exportable: true, deprecated: false },
  { key: 'dendro_ratio', unit: null, label: 'Ratio', cardType: 'dendro', edgeField: 'dendro_ratio', exportable: true, deprecated: false },
  { key: 'adc_ch0v', unit: 'V', label: 'ADC ch0', cardType: 'dendro', edgeField: 'adc_ch0v', exportable: true, deprecated: false },
  { key: 'adc_ch1v', unit: 'V', label: 'ADC ch1', cardType: 'dendro', edgeField: 'adc_ch1v', exportable: true, deprecated: false },
  { key: 'rain_count_cumulative', unit: 'count', label: 'Rain count', cardType: 'environment', edgeField: 'rain_count_cumulative', exportable: true, deprecated: false },
  { key: 'rain_tips_delta', unit: 'count', label: 'Rain tips delta', cardType: 'environment', edgeField: 'rain_tips_delta', exportable: true, deprecated: false },
  { key: 'rain_gauge_cumulative_mm', unit: 'mm', label: 'Rain cumul.', cardType: 'environment', edgeField: 'rain_gauge_cumulative_mm', exportable: true, deprecated: false },
  { key: 'flow_liters_per_min', unit: 'L/min', label: 'Flow rate', cardType: 'environment', edgeField: 'flow_liters_per_min', exportable: true, deprecated: false },
  { key: 'flow_liters_per_10min', unit: 'L/10min', label: 'Flow (10 min)', cardType: 'environment', edgeField: 'flow_liters_per_10min', exportable: true, deprecated: false },
  { key: 'flow_liters_today', unit: 'L', label: 'Flow today', cardType: 'environment', edgeField: 'flow_liters_today', exportable: true, deprecated: false },
  { key: 'flow_liters_delta', unit: 'L', label: 'Flow delta', cardType: 'environment', edgeField: 'flow_liters_delta', exportable: true, deprecated: false },
  { key: 'flow_count_cumulative', unit: 'count', label: 'Flow count', cardType: 'environment', edgeField: 'flow_count_cumulative', exportable: true, deprecated: false },
  { key: 'flow_pulses_delta', unit: 'count', label: 'Flow pulses', cardType: 'environment', edgeField: 'flow_pulses_delta', exportable: true, deprecated: false },
  { key: 'wind_direction_deg', unit: '°', label: 'Wind direction', cardType: 'environment', edgeField: 'wind_direction_deg', exportable: true, deprecated: false },
  { key: 'pipe_pressure_kpa', unit: 'kPa', label: 'Pipe pressure', cardType: 'environment', edgeField: 'pipe_pressure_kpa', exportable: true, deprecated: false },
  { key: 'global_radiation_wm2', unit: 'W/m²', label: 'Global radiation', cardType: 'environment', edgeField: null, exportable: true, deprecated: false },
  { key: 'et0_mm', unit: 'mm', label: 'Reference ET (ET0)', cardType: 'environment', edgeField: null, exportable: true, deprecated: false },
  { key: 'etc_mm', unit: 'mm', label: 'Crop water demand (ETc)', cardType: 'environment', edgeField: null, exportable: true, deprecated: false },
];

const CHANNELS_BY_KEY = new Map(CHANNELS.map((channel) => [channel.key, channel]));
const ANALYSIS_EDGE_FIELDS = new Set(CHANNELS.map((channel) => channel.edgeField).filter(Boolean));
const MAX_SELECTED_SERIES = 25;
const MAX_RAW_ROWS = 30000;
const MAX_RANGE_DAYS = 400;
const MAX_VIEW_NAME_LENGTH = 120;

// SOURCE_KINDS (the per-table/channel shape used by the weather path) and
// the weather-table reader functions live in analysis-sources.js (final fix
// A7, queue T3 advice): this file crossed 800 lines once the final fix
// wave's items landed. See that file for the shape and its spec reference.

const ANALYSIS_VIEWS_SCHEMA = `CREATE TABLE IF NOT EXISTS analysis_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  owner_user_uuid TEXT,
  name TEXT NOT NULL,
  view_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`;

function analysisSeriesId(zoneId, cardType, sourceKey, channelKey) {
  return crypto
    .createHash('sha256')
    .update(`${zoneId}|${cardType}|${sourceKey}|${channelKey}`)
    .digest('hex')
    .slice(0, 16);
}

// One catalogue entry literal, shared by the device path and every
// addWeatherSource() channel (final review, queue T3 N2): both built the
// same twelve-field shape by hand.
function buildCatalogEntry({ zone, hubEui, cardType, sourceKey, channelKey, meta, deviceName, availability, depthCm, sourceKind }) {
  return {
    seriesId: analysisSeriesId(zone.id, cardType, sourceKey, channelKey),
    hubEui,
    zoneId: zone.id,
    zoneName: zone.name || null,
    cardType,
    sourceKey,
    channelKey,
    displayName: [deviceName, meta.label].filter(Boolean).join(' - '),
    unit: meta.unit,
    availability,
    deviceName,
    depthCm,
    sourceKind,
  };
}

// One series envelope, shared by the device path and weatherSeries() (final
// review, queue T3 N2): both built the same seven-field response shape.
function buildSeriesEnvelope(entry, { unit, points, cadence }) {
  return {
    seriesId: entry.seriesId,
    resolved: {
      hubEui: entry.hubEui,
      zoneId: entry.zoneId,
      cardType: entry.cardType,
      sourceKey: entry.sourceKey,
      channelKey: entry.channelKey,
    },
    label: entry.displayName,
    unit,
    points,
    truncated: false,
    cadence,
    timezone: entry.timezone,
  };
}

function normalizeCardType(value) {
  const cardType = String(value || '').trim().toLowerCase();
  return cardType === 'env' ? 'environment' : cardType;
}

function boolFlag(value) {
  return value === true || value === 1 || String(value || '').toLowerCase() === 'true';
}

// Spec docs/superpowers/specs/2026-09-27-weather-data-view-design.md
// ("Catalogue entries"): these channels exist only in the weather tables, so
// no device source lists them. vwc (edgeField null) stays listed as an
// unsupported soil row, so the rule is this named set and not "edgeField".
const DEVICE_EXCLUDED_CHANNELS = new Set(['global_radiation_wm2', 'et0_mm', 'etc_mm']);

function cardChannels(cardType) {
  const normalized = normalizeCardType(cardType);
  return CHANNELS
    .filter((channel) => channel.cardType === normalized && channel.exportable !== false && channel.deprecated !== true)
    .filter((channel) => !DEVICE_EXCLUDED_CHANNELS.has(channel.key))
    .map((channel) => channel.key);
}

function filterAvailable(cardType, defaults) {
  const allowed = new Set(cardChannels(cardType));
  return defaults.filter((key) => allowed.has(key));
}

function configuredChannels(cardType, source) {
  const configured = new Set(Array.isArray(source && source.configuredChannels) ? source.configuredChannels : []);
  return cardChannels(cardType).filter((key) => configured.has(key));
}

function cardChannelsForSource(cardType, source = null) {
  const normalized = normalizeCardType(cardType);
  if (!source) return cardChannels(normalized);

  if (normalized === 'soil' && boolFlag(source.chameleonEnabled ?? source.chameleon_enabled)) {
    return filterAvailable(normalized, ['swt_1', 'swt_2', 'swt_3']);
  }

  if (normalized === 'soil') {
    const deviceType = String(source.deviceType || source.typeId || source.type_id || '').trim().toUpperCase();
    if (deviceType === 'DRAGINO_SDI12') return configuredChannels(normalized, source);
    if (deviceType === 'DRAGINO_LSN50') return filterAvailable(normalized, ['swt_1', 'swt_2']);
    if (deviceType === 'KIWI_SENSOR') return filterAvailable(normalized, ['swt_1', 'swt_2']);
    if (deviceType === 'TEKTELIC_CLOVER') return [];
  }

  if (normalized === 'environment') {
    const deviceType = String(source.deviceType || source.typeId || source.type_id || '').trim().toUpperCase();
    if (deviceType === 'DRAGINO_LSN50') {
      return boolFlag(source.tempEnabled ?? source.temp_enabled) ? filterAvailable(normalized, ['ext_temperature_c']) : [];
    }
    if (deviceType === 'KIWI_SENSOR') {
      return filterAvailable(normalized, ['ambient_temperature', 'relative_humidity', 'light_lux']);
    }
  }

  return cardChannels(normalized);
}

function channelMeta(channelKey) {
  const key = String(channelKey || '').trim();
  const meta = CHANNELS_BY_KEY.get(key);
  if (!meta) {
    const error = new Error(`unknown analysis channel: ${key}`);
    error.statusCode = 400;
    throw error;
  }
  return {
    key: meta.key,
    label: meta.label,
    unit: meta.unit,
    edgeField: meta.edgeField,
  };
}

function sqlIdent(field) {
  const name = String(field || '').trim();
  if (!ANALYSIS_EDGE_FIELDS.has(name)) {
    const error = new Error(`unsupported analysis field: ${name}`);
    error.statusCode = 400;
    throw error;
  }
  return name;
}

function unique(values) {
  return Array.from(new Set(values));
}

function tooLarge(message, suggestion) {
  const error = new Error(message);
  error.statusCode = 413;
  error.suggestion = suggestion;
  return error;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function dbRun(db, sql, params) {
  return new Promise((resolve, reject) => {
    if (!db || typeof db.run !== 'function') return reject(new Error('analysis views require db.run'));
    try {
      if (db.run.length >= 3) {
        db.run(sql, params, function(error) {
          error ? reject(error) : resolve(this || {});
        });
        return undefined;
      }
      const result = db.run(sql, params);
      if (result && typeof result.then === 'function') return result.then(resolve, reject);
      return resolve(result || {});
    } catch (error) {
      return reject(error);
    }
  });
}

function normalizeRange(range = {}) {
  const from = range.from || range.start || range.startAt;
  const to = range.to || range.end || range.endAt;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    const error = new Error('range requires from before to');
    error.statusCode = 400;
    throw error;
  }
  const spanDays = (toMs - fromMs) / (24 * 60 * 60 * 1000);
  if (spanDays > MAX_RANGE_DAYS) {
    throw tooLarge('range too large', 'Narrow the date range.');
  }
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

// Without `spec` this is the device path, unchanged: the bucket mean, the
// bucket's sample count and the cadence confidence. With `spec` (the weather
// kinds) a 'sum' channel reports the bucket total, a 'mean' channel the
// bucket mean, and EVERY channel -- final review I2 -- is marked partial
// when the bucket holds fewer rows than `expected` (a daily mean of 9 of 24
// hours is a partial mean, not a full day's mean).
function aggToPoints(aggregate, channelKey, spec) {
  const rawPoints = aggregate && aggregate.series && aggregate.series[channelKey] && aggregate.series[channelKey].points;
  if (Array.isArray(rawPoints)) {
    return rawPoints.map((point) => ({
      t: point.recordedAt,
      value: point.value,
      count: 1,
      quality: null,
    }));
  }
  return (aggregate && aggregate.buckets || []).map((bucket) => {
    const stats = bucket.series && bucket.series[channelKey] || {};
    if (!spec) {
      return {
        t: bucket.bucketStart,
        value: stats.mean ?? null,
        count: Number(stats.sampleCount || 0),
        quality: bucket.coverageConfidence || null,
      };
    }
    const count = Number(stats.sampleCount || 0);
    const expected = Number.isInteger(spec.expected) ? spec.expected : null;
    return {
      t: bucket.bucketStart,
      value: (spec.stat === 'sum' ? stats.sum : stats.mean) ?? null,
      count,
      expected,
      quality: expected !== null && count > 0 && count < expected ? 'partial' : null,
    };
  });
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function userIdFor(input = {}) {
  const userId = Number(input.userId ?? input.user_id);
  if (!Number.isInteger(userId) || userId <= 0) throw badRequest('userId is required');
  return userId;
}

function normalizeViewPayload(view = {}) {
  let parsed;
  try {
    parsed = typeof view === 'string' ? JSON.parse(view) : { ...(view || {}) };
  } catch (error) {
    throw badRequest('view payload must be valid JSON');
  }
  const name = String(parsed.name || '').trim();
  if (!name || name.length > MAX_VIEW_NAME_LENGTH) throw badRequest('view name is required and must be 120 characters or fewer');
  const selectors = Array.isArray(parsed.selectors) ? parsed.selectors : [];
  const normalizedSelectors = [];
  for (const selector of selectors) {
    const seriesId = String(selector && selector.seriesId || '').trim();
    if (!seriesId) throw badRequest('view selectors require seriesId');
    normalizedSelectors.push({ ...selector, seriesId });
  }
  return {
    ...parsed,
    name,
    selectors: normalizedSelectors,
    schemaVersion: parsed.schemaVersion || 1,
  };
}

function parseViewRow(row) {
  let parsed;
  try {
    parsed = JSON.parse(row.view_json);
  } catch (error) {
    parsed = { schemaVersion: 1, name: row.name, selectors: [] };
  }
  return {
    ...parsed,
    id: row.id,
    userId: row.user_id,
    ownerUserUuid: row.owner_user_uuid || null,
    name: row.name,
    isDefault: Number(row.is_default || 0) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function displaySafeDeviceContext(device) {
  function parseObject(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  const depths = parseObject(device && (device.soil_moisture_probe_depths_json || device.soilMoistureProbeDepthsJson));
  const layout = parseObject(device && (device.sdi12_channel_layout_json || device.sdi12ChannelLayoutJson));
  const configuredChannels = depths ? Object.keys(depths) : [];
  if (!configuredChannels.length && layout && Array.isArray(layout.sensors)) {
    for (const sensor of layout.sensors) {
      const channel = Number(sensor && sensor.channel);
      if (!Number.isInteger(channel) || channel < 1 || channel > 10) continue;
      configuredChannels.push(`vwc_${channel}`);
      if (String(sensor.type || '').toUpperCase() === 'TRISCAN') configuredChannels.push(`soil_vic_${channel}`);
    }
  }
  return {
    deviceType: device && (device.type_id || device.typeId),
    typeId: device && (device.type_id || device.typeId),
    chameleonEnabled: device && (device.chameleon_enabled || device.chameleonEnabled),
    tempEnabled: device && (device.temp_enabled || device.tempEnabled),
    configuredChannels,
  };
}

function createAnalysis(deps) {
  const {
    aggregateRows,
    annotateWatermarkEvidence,
    dbAll,
    deriveCardsForZone,
    displayDeviceName,
    localDateKey,
    normalizeDeveui,
    normalizeTimezone,
    resolveAggregation,
    soilDepthCm,
    sourceDevicesForCard,
    sourceKeyForCsv,
    zoneDateStartIso,
    zoneLocations,
  } = deps || {};

  // One warning for the life of this createAnalysis() instance (index.js
  // builds exactly one in a running gateway process, final fix A4).
  let weatherTablesMissingWarned = false;

  // The weather-table readers (final fix A7, analysis-sources.js): they use
  // the two response builders above, so those are passed in as deps rather
  // than duplicated.
  const {
    weatherTablesPresent,
    loadZoneWeather,
    loadZoneStations,
    readWeatherRows,
    weatherSeries,
  } = createWeatherSources({ dbAll, zoneLocations, localDateKey, zoneDateStartIso, aggregateRows, buildSeriesEnvelope, aggToPoints });

  async function buildAnalysisCatalog(db, options = {}) {
    const hubEui = String(options.deviceEui || options.device_eui || '').trim().toUpperCase();
    const userId = userIdFor(options);
    const zoneUuids = Array.isArray(options.zoneUuids) ? options.zoneUuids : null;
    const zones = zoneUuids === null
      ? await dbAll(
        db,
        'SELECT * FROM irrigation_zones WHERE deleted_at IS NULL AND user_id = ? ORDER BY id ASC',
        [userId]
      )
      : zoneUuids.length
        ? await dbAll(
          db,
          `SELECT * FROM irrigation_zones WHERE deleted_at IS NULL AND zone_uuid IN (${zoneUuids.map(() => '?').join(',')}) ORDER BY id ASC`,
          zoneUuids
        )
        : [];
    const channels = [];
    const entriesById = new Map();
    const deploymentDefault = options.weatherProviderDefault !== undefined
      ? options.weatherProviderDefault
      : process.env.OSI_WEATHER_PROVIDER_DEFAULT;
    // Final fix A4 (review T3 M1): a gateway that has not yet run the
    // schema migration, or a database missing a table for any other reason,
    // gets a device-only catalogue and one warning instead of a 500 for
    // every analysis request. Any other error (a real query failure) still
    // propagates and still answers 500.
    const weatherAvailable = zones.length ? await weatherTablesPresent(db) : true;
    if (!weatherAvailable && !weatherTablesMissingWarned) {
      weatherTablesMissingWarned = true;
      console.warn('osi-history-helper analysis: weather tables missing (deploy the schema migration); the catalogue lists device sources only');
    }
    const weather = zones.length && weatherAvailable
      ? await loadZoneWeather(db, deploymentDefault)
      : { byZoneId: new Map(), rowsByKey: new Map() };
    const stationsByZoneId = zones.length && weatherAvailable
      ? await loadZoneStations(db, zones.map((zone) => zone.id), userId, zoneUuids === null)
      : new Map();

    for (const zone of zones) {
      const timezone = normalizeTimezone(zone.timezone);
      // Production wiring (osi-history-helper index.js) always injects the
      // annotator; structural tests that omit it see the raw rows.
      const loadedDevices = zoneUuids === null
        ? await dbAll(
          db,
          'SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ? AND user_id = ? ORDER BY deveui ASC',
          [zone.id, userId]
        )
        : await dbAll(
          db,
          'SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ? ORDER BY deveui ASC',
          [zone.id]
        );
      const devices = typeof annotateWatermarkEvidence === 'function'
        ? await annotateWatermarkEvidence(db, loadedDevices)
        : loadedDevices;
      const cards = deriveCardsForZone(zone, devices);
      for (const card of cards) {
        const sourceDevices = sourceDevicesForCard(card, devices)
          .slice()
          .sort((left, right) =>
            String(normalizeDeveui(left.deveui || left.device_eui) || '').localeCompare(String(normalizeDeveui(right.deveui || right.device_eui) || ''))
          );
        sourceDevices.forEach((device, index) => {
          const deveui = normalizeDeveui(device.deveui || device.device_eui || device.deviceEui);
          const sourceKey = sourceKeyForCsv(card, device);
          if (!deveui || !sourceKey) return;
          const deviceName = displayDeviceName(device, index);
          for (const channelKey of cardChannelsForSource(card.cardType, displaySafeDeviceContext(device))) {
            const meta = channelMeta(channelKey);
            const entry = buildCatalogEntry({
              zone,
              hubEui,
              cardType: card.cardType,
              sourceKey,
              channelKey,
              meta,
              deviceName,
              availability: meta.edgeField ? 'available' : 'unsupported',
              depthCm: soilDepthCm(device, channelKey),
              sourceKind: 'device',
            });
            channels.push(entry);
            entriesById.set(entry.seriesId, { ...entry, deveui, owner: deveui, timezone, provider: null });
          }
        });
      }

      if (!weatherAvailable) continue;

      const addWeatherSource = (sourceKind, sourceKey, deviceName, owner, provider) => {
        for (const channelKey of Object.keys(SOURCE_KINDS[sourceKind].channels)) {
          const meta = channelMeta(channelKey);
          const entry = buildCatalogEntry({
            zone,
            hubEui,
            cardType: 'environment',
            sourceKey,
            channelKey,
            meta,
            deviceName,
            availability: 'available',
            depthCm: null,
            sourceKind,
          });
          channels.push(entry);
          entriesById.set(entry.seriesId, { ...entry, owner, timezone, provider });
        }
      };

      const located = weather.byZoneId.get(Number(zone.id));
      const locationRow = located && located.locationKey ? weather.rowsByKey.get(located.locationKey) : null;
      if (locationRow) {
        addWeatherSource(
          'weather_provider',
          `weather-src-${sha256Hex(located.locationKey).slice(0, 12)}`,
          providerSourceName(locationRow),
          located.locationKey,
          locationRow.provider
        );
      }
      const stations = stationsByZoneId.get(Number(zone.id)) || [];
      stations.forEach((device, index) => {
        addWeatherSource(
          'weather_station',
          `station-src-${sha256Hex(normalizeDeveui(device.deveui)).slice(0, 12)}`,
          `${displayDeviceName(device, index)} (hourly)`,
          device.deveui,
          null
        );
      });
      const zoneName = String(zone.name || '').trim();
      addWeatherSource(
        'zone_daily_agronomy',
        'agronomy-src-zone',
        `${zoneName || `Zone ${zone.id}`} daily agronomy`,
        zone.id,
        null
      );
    }

    return { generatedAt: new Date().toISOString(), channels, entriesById, weatherAvailable };
  }

  async function resolveAnalysisSeries(db, options = {}) {
    const ids = (Array.isArray(options.selectors) ? options.selectors : [])
      .map((selector) => selector && selector.seriesId)
      .filter(Boolean);
    if (ids.length > MAX_SELECTED_SERIES) {
      throw tooLarge('too many selected series', 'Select fewer series.');
    }

    const range = normalizeRange(options.range || options);
    const aggregationInfo = resolveAggregation({
      aggregation: options.aggregation,
      from: range.from,
      to: range.to,
    });
    const { entriesById, weatherAvailable } = await buildAnalysisCatalog(db, options);
    const series = [];
    const dropped = [];
    const groups = new Map();
    // Scoped to this one resolveAnalysisSeries call: aggregateRows clones a
    // cached bucket skeleton per (range, level, timezone) key instead of
    // recomputing it once per selected weather channel (final fix A1).
    const bucketSkeletonCache = new Map();

    for (const id of ids) {
      const entry = entriesById.get(id);
      if (!entry) {
        // A weather selector that no longer resolves because the weather
        // tables are absent is reported distinctly from a genuinely unknown
        // id (final fix A4, review T3 M1): the degraded catalogue cannot
        // tell the two apart by id alone, so every miss while the tables
        // are down is reported as a dropped source, not an unknown one.
        dropped.push({ seriesId: id, reason: weatherAvailable ? 'unknown' : 'source_unavailable' });
        continue;
      }
      const kind = entry.sourceKind || 'device';
      const meta = channelMeta(entry.channelKey);
      if (kind === 'device' && !meta.edgeField) {
        dropped.push({ seriesId: id, reason: 'unsupported' });
        continue;
      }
      const key = `${kind}|${entry.owner}`;
      if (!groups.has(key)) groups.set(key, { kind, owner: entry.owner, entries: [] });
      groups.get(key).entries.push({ entry, meta });
    }

    let rawRowsScanned = 0;
    for (const group of groups.values()) {
      const remaining = MAX_RAW_ROWS - rawRowsScanned;
      if (remaining <= 0) {
        throw tooLarge('range too large', 'Narrow the date range or pick a coarser granularity.');
      }
      const rows = group.kind === 'device'
        ? await dbAll(
          db,
          `SELECT deveui, recorded_at, ${unique(group.entries.map(({ meta }) => meta.edgeField)).map(sqlIdent).join(', ')} FROM device_data WHERE deveui = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at ASC LIMIT ?`,
          [group.owner, range.from, range.to, remaining + 1]
        )
        : await readWeatherRows(db, { kind: group.kind, owner: group.owner, entries: group.entries.map(({ entry }) => entry) }, range, remaining + 1);
      if (rows.length > remaining) {
        throw tooLarge('range too large', 'Narrow the date range or pick a coarser granularity.');
      }
      rawRowsScanned += rows.length;
      for (const { entry, meta } of group.entries) {
        if (group.kind !== 'device') {
          series.push(weatherSeries(entry, rows, range, aggregationInfo, bucketSkeletonCache));
          continue;
        }
        const aggregate = aggregateRows(rows, {
          aggregation: options.aggregation,
          aggregationRequested: aggregationInfo.requested,
          channels: [{ id: entry.channelKey, field: meta.edgeField, unit: entry.unit }],
          from: range.from,
          to: range.to,
        });
        series.push(buildSeriesEnvelope(entry, {
          unit: entry.unit,
          points: aggToPoints(aggregate, entry.channelKey),
          cadence: 'hourly',
        }));
      }
    }

    return {
      range,
      aggregation: { requested: aggregationInfo.requested, applied: aggregationInfo.level },
      series,
      dropped,
    };
  }

  async function listAnalysisViews(db, user = {}) {
    const userId = userIdFor(user);
    const rows = await dbAll(
      db,
      'SELECT * FROM analysis_views WHERE user_id = ? ORDER BY updated_at DESC, id DESC',
      [userId]
    );
    const { entriesById } = await buildAnalysisCatalog(db, user);
    return rows.map((row) => {
      const view = parseViewRow(row);
      const selectors = Array.isArray(view.selectors) ? view.selectors : [];
      const kept = [];
      const droppedSeriesIds = [];
      for (const selector of selectors) {
        const seriesId = String(selector && selector.seriesId || '').trim();
        if (seriesId && entriesById.has(seriesId)) kept.push({ ...selector, seriesId });
        else if (seriesId) droppedSeriesIds.push(seriesId);
      }
      return { ...view, selectors: kept, droppedSeriesIds };
    });
  }

  async function saveAnalysisView(db, user = {}, view = {}) {
    const userId = userIdFor(user);
    const ownerUserUuid = String(user.ownerUserUuid || user.owner_user_uuid || '').trim() || null;
    const payload = normalizeViewPayload(view);
    const isDefault = payload.isDefault || payload.is_default ? 1 : 0;
    const viewJson = JSON.stringify(payload);
    const id = Number(payload.id);

    if (Number.isInteger(id) && id > 0) {
      await dbRun(
        db,
        'UPDATE analysis_views SET owner_user_uuid = ?, name = ?, view_json = ?, is_default = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [ownerUserUuid, payload.name, viewJson, isDefault, id, userId]
      );
      const rows = await dbAll(db, 'SELECT * FROM analysis_views WHERE id = ? AND user_id = ?', [id, userId]);
      if (!rows.length) {
        const error = new Error('analysis view not found');
        error.statusCode = 404;
        throw error;
      }
      return parseViewRow(rows[0]);
    }

    await dbRun(
      db,
      'INSERT INTO analysis_views(user_id, owner_user_uuid, name, view_json, is_default) VALUES (?, ?, ?, ?, ?)',
      [userId, ownerUserUuid, payload.name, viewJson, isDefault]
    );
    const rows = await dbAll(db, 'SELECT * FROM analysis_views WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    return parseViewRow(rows[0]);
  }

  // Deletes one saved view of the caller. Views are per user in every mode:
  // another user's view and a missing one both answer 404, so the route does
  // not reveal which ids exist.
  async function deleteAnalysisView(db, user = {}, viewId) {
    const userId = userIdFor(user);
    const raw = String(viewId === undefined || viewId === null ? '' : viewId).trim();
    const id = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw badRequest('analysis view id must be a positive integer');
    }
    const rows = await dbAll(db, 'SELECT id FROM analysis_views WHERE id = ? AND user_id = ?', [id, userId]);
    if (!rows.length) {
      const error = new Error('analysis view not found');
      error.statusCode = 404;
      throw error;
    }
    await dbRun(db, 'DELETE FROM analysis_views WHERE id = ? AND user_id = ?', [id, userId]);
  }

  return {
    ANALYSIS_VIEWS_SCHEMA,
    analysisSeriesId,
    buildAnalysisCatalog,
    listAnalysisViews,
    resolveAnalysisSeries,
    saveAnalysisView,
    deleteAnalysisView,
  };
}

module.exports = {
  ANALYSIS_VIEWS_SCHEMA,
  DEVICE_EXCLUDED_CHANNELS,
  SOURCE_KINDS,
  analysisSeriesId,
  createAnalysis,
};
