'use strict';

const crypto = require('crypto');

const CHANNELS = [
  { key: 'swt_1', unit: 'kPa', label: 'Soil tension (S1)', cardType: 'soil', edgeField: 'swt_1', exportable: true, deprecated: false },
  { key: 'swt_2', unit: 'kPa', label: 'Soil tension (S2)', cardType: 'soil', edgeField: 'swt_2', exportable: true, deprecated: false },
  { key: 'swt_3', unit: 'kPa', label: 'Soil tension (S3)', cardType: 'soil', edgeField: 'swt_3', exportable: true, deprecated: false },
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
];

const CHANNELS_BY_KEY = new Map(CHANNELS.map((channel) => [channel.key, channel]));
const ANALYSIS_EDGE_FIELDS = new Set(CHANNELS.map((channel) => channel.edgeField).filter(Boolean));
const MAX_SELECTED_SERIES = 25;
const MAX_RAW_ROWS = 30000;
const MAX_RANGE_DAYS = 400;
const MAX_VIEW_NAME_LENGTH = 120;

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

function normalizeCardType(value) {
  const cardType = String(value || '').trim().toLowerCase();
  return cardType === 'env' ? 'environment' : cardType;
}

function boolFlag(value) {
  return value === true || value === 1 || String(value || '').toLowerCase() === 'true';
}

function cardChannels(cardType) {
  const normalized = normalizeCardType(cardType);
  return CHANNELS
    .filter((channel) => channel.cardType === normalized && channel.exportable !== false && channel.deprecated !== true)
    .map((channel) => channel.key);
}

function filterAvailable(cardType, defaults) {
  const allowed = new Set(cardChannels(cardType));
  return defaults.filter((key) => allowed.has(key));
}

function cardChannelsForSource(cardType, source = null) {
  const normalized = normalizeCardType(cardType);
  if (!source) return cardChannels(normalized);

  if (normalized === 'soil' && boolFlag(source.chameleonEnabled ?? source.chameleon_enabled)) {
    return filterAvailable(normalized, ['swt_1', 'swt_2', 'swt_3']);
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

function aggToPoints(aggregate, channelKey) {
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
    return {
      t: bucket.bucketStart,
      value: stats.mean ?? null,
      count: Number(stats.sampleCount || 0),
      quality: bucket.coverageConfidence || null,
    };
  });
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
  return {
    deviceType: device && (device.type_id || device.typeId),
    typeId: device && (device.type_id || device.typeId),
    chameleonEnabled: device && (device.chameleon_enabled || device.chameleonEnabled),
    tempEnabled: device && (device.temp_enabled || device.tempEnabled),
  };
}

function createAnalysis(deps) {
  const {
    aggregateRows,
    dbAll,
    deriveCardsForZone,
    displayDeviceName,
    normalizeDeveui,
    resolveAggregation,
    soilDepthCm,
    sourceDevicesForCard,
    sourceKeyForCsv,
  } = deps || {};

  async function buildAnalysisCatalog(db, options = {}) {
    const hubEui = String(options.deviceEui || options.device_eui || '').trim().toUpperCase();
    const userId = userIdFor(options);
    const zones = await dbAll(db, 'SELECT * FROM irrigation_zones WHERE deleted_at IS NULL AND user_id = ? ORDER BY id ASC', [userId]);
    const channels = [];
    const entriesById = new Map();

    for (const zone of zones) {
      const devices = await dbAll(db, 'SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ? AND user_id = ? ORDER BY deveui ASC', [zone.id, userId]);
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
            const seriesId = analysisSeriesId(zone.id, card.cardType, sourceKey, channelKey);
            const entry = {
              seriesId,
              hubEui,
              zoneId: zone.id,
              zoneName: zone.name || null,
              cardType: card.cardType,
              sourceKey,
              channelKey,
              displayName: [deviceName, meta.label].filter(Boolean).join(' - '),
              unit: meta.unit,
              availability: meta.edgeField ? 'available' : 'unsupported',
              deviceName,
              depthCm: soilDepthCm(device, channelKey),
            };
            channels.push(entry);
            entriesById.set(seriesId, { ...entry, deveui });
          }
        });
      }
    }

    return { generatedAt: new Date().toISOString(), channels, entriesById };
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
    const { entriesById } = await buildAnalysisCatalog(db, options);
    const series = [];
    const dropped = [];
    const byDeveui = new Map();

    for (const id of ids) {
      const entry = entriesById.get(id);
      if (!entry) {
        dropped.push({ seriesId: id, reason: 'unknown' });
        continue;
      }
      const meta = channelMeta(entry.channelKey);
      if (!meta.edgeField) {
        dropped.push({ seriesId: id, reason: 'unsupported' });
        continue;
      }
      const key = entry.deveui;
      if (!byDeveui.has(key)) byDeveui.set(key, []);
      byDeveui.get(key).push({ entry, meta });
    }

    let rawRowsScanned = 0;
    for (const [deveui, entries] of byDeveui) {
      const fields = unique(entries.map(({ meta }) => meta.edgeField)).map(sqlIdent);
      const remaining = MAX_RAW_ROWS - rawRowsScanned;
      if (remaining <= 0) {
        throw tooLarge('range too large', 'Narrow the date range or pick a coarser granularity.');
      }
      const rows = await dbAll(
        db,
        `SELECT deveui, recorded_at, ${fields.join(', ')} FROM device_data WHERE deveui = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at ASC LIMIT ?`,
        [deveui, range.from, range.to, remaining + 1]
      );
      if (rows.length > remaining) {
        throw tooLarge('range too large', 'Narrow the date range or pick a coarser granularity.');
      }
      rawRowsScanned += rows.length;
      for (const { entry, meta } of entries) {
        const aggregate = aggregateRows(rows, {
          aggregation: options.aggregation,
          aggregationRequested: aggregationInfo.requested,
          channels: [{ id: entry.channelKey, field: meta.edgeField, unit: entry.unit }],
          from: range.from,
          to: range.to,
        });
        series.push({
          seriesId: entry.seriesId,
          resolved: {
            hubEui: entry.hubEui,
            zoneId: entry.zoneId,
            cardType: entry.cardType,
            sourceKey: entry.sourceKey,
            channelKey: entry.channelKey,
          },
          label: entry.displayName,
          unit: entry.unit,
          points: aggToPoints(aggregate, entry.channelKey),
          truncated: false,
        });
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

  return {
    ANALYSIS_VIEWS_SCHEMA,
    analysisSeriesId,
    buildAnalysisCatalog,
    listAnalysisViews,
    resolveAnalysisSeries,
    saveAnalysisView,
  };
}

module.exports = {
  ANALYSIS_VIEWS_SCHEMA,
  analysisSeriesId,
  createAnalysis,
};
