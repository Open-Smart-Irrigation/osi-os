'use strict';

const crypto = require('crypto');
const historyHelper = require('../osi-history-helper');

const LIMITS = {
  maxPointsPerSeries: 2000,
  maxEvents: 200,
  maxInterpretations: 20
};

const RANGE_DURATIONS_MS = {
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
};

const CARD_CONFIG = {
  soil: {
    scope: 'zone',
    title: 'Soil Moisture',
    subtitle: 'Root-zone tension',
    defaultView: 'soil-profile',
    views: ['soil-profile', 'line-chart', 'calendar', 'irrigation-response', 'advanced'],
    supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
    defaultRange: '24h',
    channels: [
      { id: 'swt_1', field: 'swt_1', label: 'SWT 1', unit: 'kPa' },
      { id: 'swt_2', field: 'swt_2', label: 'SWT 2', unit: 'kPa' },
      { id: 'swt_3', field: 'swt_3', label: 'SWT 3', unit: 'kPa' }
    ],
    dominantStatusMethod: 'soil-status-priority'
  },
  dendro: {
    scope: 'zone',
    title: 'Dendro - Growth Timeline',
    subtitle: 'Stem movement and recovery',
    defaultView: 'growth-timeline',
    views: ['growth-timeline', 'line-chart', 'stress-events', 'calendar', 'advanced'],
    supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
    defaultRange: '7d',
    channels: [
      { id: 'dendro_stem_change_um', field: 'dendro_stem_change_um', label: 'Stem Change', unit: 'um' },
      { id: 'dendro_delta_mm', field: 'dendro_delta_mm', label: 'Delta', unit: 'mm' },
      { id: 'dendro_ratio', field: 'dendro_ratio', label: 'Ratio', unit: null },
      { id: 'dendro_position_mm', field: 'dendro_position_mm', label: 'Position', unit: 'mm' }
    ],
    dominantStatusMethod: 'dendro-status-priority'
  },
  environment: {
    scope: 'zone',
    title: 'Environment - Microclimate',
    subtitle: 'Temperature, humidity, and rain context',
    defaultView: 'line-chart',
    views: ['line-chart', 'daily-min-max', 'calendar', 'advanced'],
    supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
    defaultRange: '24h',
    channels: [
      { id: 'ambient_temperature', field: 'ambient_temperature', label: 'Ambient Temperature', unit: 'C' },
      { id: 'ext_temperature_c', field: 'ext_temperature_c', label: 'External Temperature', unit: 'C' },
      { id: 'relative_humidity', field: 'relative_humidity', label: 'Relative Humidity', unit: '%' },
      { id: 'light_lux', field: 'light_lux', label: 'Light', unit: 'lux' },
      { id: 'rain_mm_per_hour', field: 'rain_mm_per_hour', label: 'Rain Rate', unit: 'mm/h' }
    ],
    dominantStatusMethod: 'environment-status-priority'
  },
  irrigation: {
    scope: 'zone',
    title: 'Irrigation - Events',
    subtitle: 'Valve actions and irrigation outcomes',
    defaultView: 'event-timeline',
    views: ['event-timeline', 'calendar', 'advanced'],
    supportedRanges: ['12h', '24h', '7d', '30d', 'season'],
    defaultRange: '7d',
    channels: [],
    dominantStatusMethod: 'irrigation-event-priority'
  },
  gateway: {
    scope: 'gateway',
    title: 'Gateway - Hub Status',
    subtitle: 'Local gateway connectivity',
    defaultView: 'status-overview',
    views: ['status-overview', 'advanced'],
    supportedRanges: ['12h', '24h', '7d', '30d'],
    defaultRange: '24h',
    channels: [],
    dominantStatusMethod: 'gateway-status-priority'
  }
};

function safeFilenamePart(value, fallback) {
  const text = String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return text || fallback;
}

function httpError(statusCode, message, detail) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (detail !== undefined) error.detail = detail;
  throw error;
}

function parseZoneId(value) {
  const zoneId = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(zoneId)) httpError(400, 'Invalid zone ID');
  return zoneId;
}

function boolValue(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === false) return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonObject(value, fieldName) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  httpError(400, 'Invalid ' + fieldName);
}

function sortIsoDesc(values) {
  return values.filter(Boolean).sort(function(left, right) {
    return Date.parse(right) - Date.parse(left);
  });
}

function latestIso(values) {
  const sorted = sortIsoDesc(values);
  return sorted.length ? sorted[0] : null;
}

function supportedRangesForCard(config, scopeContext) {
  const ranges = (config.supportedRanges || []).map(function(value) { return String(value); });
  if (ranges.indexOf('season') === -1) return ranges;
  if (scopeContext && scopeContext.activeSeason) return ranges;
  return ranges.filter(function(range) { return range !== 'season'; });
}

function seasonBoundaryIso(value, endOfDay) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw + (endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z');
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function seasonRangeForContext(scopeContext) {
  const season = scopeContext && scopeContext.activeSeason;
  if (!season) httpError(400, 'Season range is unavailable for this zone');
  const from = seasonBoundaryIso(season.starts_on, false);
  const to = seasonBoundaryIso(season.ends_on, true);
  if (!from || !to || Date.parse(to) <= Date.parse(from)) {
    httpError(400, 'Season range is unavailable for this zone');
  }
  return {
    label: 'season',
    from: from,
    to: to,
    timezone: scopeContext.timezone,
    seasonId: season.id,
    seasonUuid: season.season_uuid || null,
    seasonName: season.name || null
  };
}

function parseRangeSelection(query, config, scopeContext, opts) {
  const timezone = scopeContext && scopeContext.timezone ? scopeContext.timezone : 'UTC';
  const rawLabel = String((query && query.range) || config.defaultRange || '24h').trim().toLowerCase();
  const supported = supportedRangesForCard(config, scopeContext);
  if (supported.indexOf(rawLabel) === -1 && rawLabel !== 'custom') {
    if (rawLabel === 'season' && config.supportedRanges && config.supportedRanges.indexOf('season') !== -1) {
      httpError(400, 'Season range is unavailable for this zone');
    }
    httpError(400, 'Unsupported range');
  }
  const fromRaw = query && query.from ? String(query.from).trim() : '';
  const toRaw = query && query.to ? String(query.to).trim() : '';
  if (rawLabel === 'season') {
    if (fromRaw || toRaw) {
      httpError(400, 'Season range uses zone season boundaries; use custom for explicit from/to');
    }
    return seasonRangeForContext(scopeContext);
  }
  let fromMs = null;
  let toMs = null;
  if (fromRaw || toRaw) {
    if (!fromRaw || !toRaw) httpError(400, 'Both from and to are required when using an explicit range');
    fromMs = Date.parse(fromRaw);
    toMs = Date.parse(toRaw);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      httpError(400, 'Invalid from/to range');
    }
    return {
      label: rawLabel === 'custom' ? 'custom' : rawLabel,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      timezone: timezone
    };
  }
  if (rawLabel === 'custom') {
    httpError(400, 'Custom range requires from and to');
  }
  const durationMs = RANGE_DURATIONS_MS[rawLabel];
  if (!durationMs) httpError(400, 'Unsupported range');
  toMs = (opts && opts.nowMs != null) ? opts.nowMs : Date.now();
  fromMs = toMs - durationMs;
  return {
    label: rawLabel,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    timezone: timezone
  };
}

function validateView(cardType, view) {
  const config = CARD_CONFIG[cardType];
  const requested = String(view || config.defaultView || '').trim();
  if (config.views.indexOf(requested) === -1) {
    httpError(400, 'Unsupported view');
  }
  return requested;
}

function validateAggregation(value) {
  const requested = String(value || 'auto').trim().toLowerCase();
  const allowed = ['auto', 'raw', '15m', 'hourly', 'daily', 'weekly'];
  if (allowed.indexOf(requested) === -1) httpError(400, 'Unsupported aggregation');
  return requested;
}

function isSoilSource(device) {
  return historyHelper.isSoilSource(device);
}

function isEnvironmentSource(device) {
  const typeId = String(device && device.type_id || '').toUpperCase();
  return typeId === 'KIWI_SENSOR' || typeId === 'TEKTELIC_CLOVER' || typeId === 'SENSECAP_S2120' || (typeId === 'DRAGINO_LSN50' && Number(device && device.temp_enabled || 0) === 1);
}

function isIrrigationSource(device) {
  return String(device && device.type_id || '').toUpperCase() === 'STREGA_VALVE';
}

function isDendroSource(device) {
  return String(device && device.type_id || '').toUpperCase() === 'DRAGINO_LSN50' && Number(device && device.dendro_enabled || 0) === 1;
}

const isLsn50Swt3Eligible = historyHelper.isLsn50Swt3Eligible;
const normalizeDeveui = historyHelper.normalizeDeveui;
const filterSoilChannelsForSources = historyHelper.filterSoilChannelsForSources;

function pointQuality(coveragePct) {
  if (coveragePct === null || coveragePct === undefined) return 'unknown';
  if (coveragePct >= 90) return 'ok';
  if (coveragePct >= 50) return 'partial';
  if (coveragePct > 0) return 'gap';
  return 'gap';
}

function soilChannelDepths(sourceDevices) {
  const primaryDevice = (sourceDevices || [])[0] || {};
  let configured = null;
  let configuredArray = null;
  const rawConfigured = primaryDevice.soil_moisture_probe_depths_json;
  if (Array.isArray(rawConfigured)) {
    configuredArray = rawConfigured;
  } else if (rawConfigured && typeof rawConfigured === 'object') {
    configured = rawConfigured;
  } else if (typeof rawConfigured === 'string' && rawConfigured.trim()) {
    try {
      const parsed = JSON.parse(rawConfigured);
      if (Array.isArray(parsed)) configuredArray = parsed;
      else if (parsed && typeof parsed === 'object') configured = parsed;
    } catch (_) {
      configured = null;
    }
  }
  const configuredDepth = (channelId) => {
    if (configuredArray) {
      const index = { swt_1: 0, swt_2: 1, swt_3: 2, swt_wm1: 0, swt_wm2: 1 }[channelId];
      return index === undefined ? null : numberOrNull(configuredArray[index]);
    }
    return configured
      ? numberOrNull(configured[channelId] ?? configured[channelId.replace('_', '')] ?? configured[channelId.toUpperCase()])
      : null;
  };
  const chameleonEnabled = isLsn50Swt3Eligible(primaryDevice);
  return {
    swt_1: numberOrNull(primaryDevice.chameleon_swt1_depth_cm) ?? configuredDepth('swt_1'),
    swt_2: numberOrNull(primaryDevice.chameleon_swt2_depth_cm) ?? configuredDepth('swt_2'),
    swt_3: chameleonEnabled
      ? numberOrNull(primaryDevice.chameleon_swt3_depth_cm) ?? configuredDepth('swt_3')
      : null
  };
}

function soilDepthsForAggregate(aggregate, sourceDevices) {
  const devices = Array.isArray(sourceDevices) ? sourceDevices : [];
  const fallback = soilChannelDepths(devices);
  const sourceKeys = aggregate && aggregate.channelSourceKeys || {};
  const result = {};
  for (const channelId of ['swt_1', 'swt_2', 'swt_3']) {
    const sourceKey = normalizeDeveui(sourceKeys[channelId]);
    const sourceDevice = sourceKey && devices.find((device) => normalizeDeveui(device && (device.deveui || device.device_eui || device.deviceEui)) === sourceKey);
    if (sourceDevice) {
      result[channelId] = soilChannelDepths([sourceDevice])[channelId];
    } else {
      result[channelId] = fallback[channelId];
    }
  }
  return result;
}

function seriesWithDepth(series, depths, channelId) {
  const depthCm = depths && Object.prototype.hasOwnProperty.call(depths, channelId) ? depths[channelId] : null;
  return depthCm === null || depthCm === undefined ? series : Object.assign({}, series, { depthCm: depthCm });
}

function buildSeriesFromAggregate(card, aggregate, sourceDevices, opts) {
  var _statusForCardValue = opts && opts.statusForCardValue || function() { return null; };
  const configuredChannels = CARD_CONFIG[card.cardType].channels;
  const channels = card.cardType === 'soil' ? filterSoilChannelsForSources(configuredChannels, sourceDevices) : configuredChannels;
  const soilDepths = card.cardType === 'soil' ? soilDepthsForAggregate(aggregate, sourceDevices) : null;
  if (!channels.length) return [];
  const result = [];
  if (aggregate.aggregation === 'raw') {
    for (const channel of channels) {
      const channelData = aggregate.series && aggregate.series[channel.id];
      const points = channelData && Array.isArray(channelData.points)
        ? channelData.points.map(function(point) {
            return {
              t: point.recordedAt,
              value: point.value,
              coverageConfidence: aggregate.coverageConfidence || 'unknown',
              unit: channel.unit || null,
              dominantStatus: _statusForCardValue(card.cardType, channel.id, point.value),
              dominantStatusMethod: CARD_CONFIG[card.cardType].dominantStatusMethod,
              quality: 'ok'
            };
          }).filter(function(point) { return point.value !== null; })
        : [];
      if (!points.length) continue;
      result.push(seriesWithDepth({ id: channel.id, label: channel.label, unit: channel.unit || null, points: points }, soilDepths, channel.id));
    }
    return result;
  }
  const buckets = Array.isArray(aggregate.buckets) ? aggregate.buckets : [];
  for (const channel of channels) {
    const points = [];
    for (const bucket of buckets) {
      const stats = bucket.series && bucket.series[channel.id];
      if (!stats) continue;
      const pointValue = stats.latest !== null && stats.latest !== undefined ? stats.latest : (stats.mean !== null && stats.mean !== undefined ? stats.mean : null);
      const hasData = stats.sampleCount > 0 || pointValue !== null || stats.min !== null || stats.max !== null;
      if (!hasData) continue;
      points.push({
        t: bucket.bucketStart,
        bucketStart: bucket.bucketStart,
        bucketEnd: bucket.bucketEnd,
        value: pointValue,
        min: stats.min,
        max: stats.max,
        mean: stats.mean,
        median: stats.median,
        latest: stats.latest,
        dominantStatus: stats.dominantStatus || _statusForCardValue(card.cardType, channel.id, pointValue),
        dominantStatusMethod: CARD_CONFIG[card.cardType].dominantStatusMethod,
        coveragePct: bucket.coveragePct,
        coverageConfidence: bucket.coverageConfidence || 'unknown',
        count: stats.sampleCount,
        unit: stats.unit || channel.unit || null,
        quality: pointQuality(bucket.coveragePct)
      });
    }
    if (!points.length) continue;
    result.push(seriesWithDepth({ id: channel.id, label: channel.label, unit: channel.unit || null, points: points }, soilDepths, channel.id));
  }
  return result;
}

function truncateSeries(series) {
  let truncated = false;
  const next = (series || []).map(function(item) {
    if (!Array.isArray(item.points) || item.points.length <= LIMITS.maxPointsPerSeries) return item;
    truncated = true;
    return Object.assign({}, item, { points: item.points.slice(item.points.length - LIMITS.maxPointsPerSeries) });
  });
  return { series: next, truncated: truncated };
}

function latestPointTimestamp(series) {
  const values = [];
  for (const item of series || []) {
    for (const point of item.points || []) {
      if (point && point.t) values.push(point.t);
    }
  }
  return latestIso(values);
}

function latestValueBySeries(series, seriesId) {
  const selected = (series || []).find(function(item) { return item.id === seriesId; });
  if (!selected || !Array.isArray(selected.points) || !selected.points.length) return null;
  const point = selected.points[selected.points.length - 1];
  return point.latest !== undefined && point.latest !== null ? point.latest : point.value;
}

function latestBatteryMetric(latestRows) {
  const rows = Array.isArray(latestRows) ? latestRows.slice() : [];
  rows.sort(function(left, right) {
    return Date.parse(right.recorded_at || 0) - Date.parse(left.recorded_at || 0);
  });
  for (const row of rows) {
    const batV = numberOrNull(row.bat_v);
    if (batV !== null) return { status: 'ok', latest: batV, unit: 'V' };
    const batPct = numberOrNull(row.bat_pct);
    if (batPct !== null) return { status: 'ok', latest: batPct, unit: '%' };
  }
  return { status: 'unknown' };
}

function lastOpenedRankMap(preferencesByCardId) {
  const entries = Object.keys(preferencesByCardId || {}).map(function(cardId) {
    const pref = preferencesByCardId[cardId] || {};
    return {
      cardId: cardId,
      lastOpenedAt: pref.last_opened_at || null
    };
  }).filter(function(entry) { return entry.lastOpenedAt; }).sort(function(left, right) {
    return Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt);
  });
  const map = {};
  entries.forEach(function(entry, index) {
    map[entry.cardId] = index + 1;
  });
  return map;
}

function buildPreferenceMap(rows) {
  const map = {};
  for (const row of rows || []) {
    map[row.card_id] = row;
  }
  return map;
}

function normalizeWorkspaceRow(row) {
  let workspace = {};
  try {
    workspace = JSON.parse(row.workspace_json);
  } catch (_) {
    workspace = {};
  }
  return {
    id: row.id,
    userId: row.user_id,
    ownerUserUuid: row.owner_user_uuid || null,
    zoneId: row.zone_id === null || row.zone_id === undefined ? null : Number(row.zone_id),
    name: row.name,
    isDefault: boolValue(row.is_default, false),
    workspace: workspace,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function summaryScore(pref, criticalAlert) {
  const openCount = Number(pref && pref.open_count || 0);
  return openCount + (criticalAlert ? 1 : 0);
}

function shouldUseHistoryRollups(scopeContext, rangeLabel, aggregationRequested) {
  if (!scopeContext || scopeContext.scope !== 'zone') return false;
  const requested = String(aggregationRequested || 'auto').trim().toLowerCase();
  if (rangeLabel === '30d' || rangeLabel === 'season') return true;
  return requested === 'daily' || requested === 'weekly';
}

// Soil rollups are merged per zone card. A plain LSN50 (no Chameleon) may have
// written a stale SWT3 into them before per-device SWT3 filtering existed, and
// a merged bucket cannot be separated again, so a soil card with such a source
// reads raw device_data. Every other card, and every soil card without such a
// source, follows the range/aggregation rule above.
function shouldUseCardRollups(card, sourceDevices, scopeContext, rangeLabel, aggregationRequested) {
  if (card && card.cardType === 'soil' && (sourceDevices || []).some(function(device) {
    return !isLsn50Swt3Eligible(device);
  })) return false;
  return shouldUseHistoryRollups(scopeContext, rangeLabel, aggregationRequested);
}

function rowHasSoilProfileValue(row) {
  return ['swt_1', 'swt_2', 'swt_3'].some(function(channelId) {
    return numberOrNull(row && row[channelId]) !== null;
  });
}

function latestSeriesPoint(series, channelId) {
  const entry = (series || []).find(function(item) { return String(item && item.id || '') === channelId; });
  const points = entry && Array.isArray(entry.points) ? entry.points.slice() : [];
  if (!points.length) return null;
  points.sort(function(left, right) {
    return Date.parse(right && (right.t || right.bucketStart || 0)) - Date.parse(left && (left.t || left.bucketStart || 0));
  });
  return points[0] || null;
}

function pointValueForCalendar(point) {
  if (!point || typeof point !== 'object') return null;
  if (point.value !== undefined) return point.value;
  if (point.latest !== undefined) return point.latest;
  if (point.mean !== undefined) return point.mean;
  return null;
}

function calendarRowsFromSeries(series) {
  const rowsByTime = {};
  for (const entry of series || []) {
    const channelId = String(entry && entry.id || '').trim();
    if (!channelId || !Array.isArray(entry.points)) continue;
    for (const point of entry.points) {
      const t = point && (point.t || point.bucketStart || point.bucket_start);
      if (!t) continue;
      if (!rowsByTime[t]) rowsByTime[t] = { recorded_at: t };
      rowsByTime[t][channelId] = pointValueForCalendar(point);
      if (point.coveragePct !== undefined) rowsByTime[t].coveragePct = point.coveragePct;
      if (point.coverage_pct !== undefined) rowsByTime[t].coverage_pct = point.coverage_pct;
    }
  }
  return Object.keys(rowsByTime).sort().map(function(key) { return rowsByTime[key]; });
}

function latestCalendarState(calendar) {
  const days = calendar && Array.isArray(calendar.days) ? calendar.days : [];
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const state = String(days[index].state || '').trim();
    if (state && state !== 'no_data' && state !== 'no_irrigation') return state;
  }
  return days.length ? days[days.length - 1].state : 'no_data';
}

function advancedField(name, value, unit, availability) {
  return {
    field: name,
    value: value === undefined ? null : value,
    unit: unit === undefined ? null : unit,
    availability: availability
  };
}

function knownAvailableFields(latestRows) {
  const fields = new Set();
  for (const row of latestRows || []) {
    for (const key of Object.keys(row || {})) {
      if (row[key] !== null && row[key] !== undefined && key !== 'id' && key !== 'deveui' && key !== 'recorded_at') {
        fields.add(key);
      }
    }
  }
  return Array.from(fields.values()).sort();
}

function phaseSummary(phases) {
  return Object.keys(phases || {}).sort().map(function(key) { return key + ':' + String(phases[key]); }).join(',');
}

function displayDeviceName(device, index) {
  const name = String(device && device.name || '').trim();
  if (name && !/\b[0-9a-fA-F]{16}\b/.test(name)) return name;
  const typeId = String(device && device.type_id || '').trim();
  if (typeId) return typeId.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, function(char) { return char.toUpperCase(); });
  return 'Source ' + String(index + 1);
}

function displaySourceLabels(devices) {
  return (devices || []).map(function(device, index) {
    return displayDeviceName(device, index);
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Portable history routes: GET /api/history/export.csv (every zone the caller
// may read, one CSV) and DELETE /api/analysis/views/:id (one saved view of the
// caller). Served by the "Portable History API" function node, which hands in
// the database, the history helper and, with scoped access on only, the scope
// helper. Authentication and scope follow the neighbouring routes: the export
// as the per-zone export of the History API Router, the delete as the saved
// views of the Analysis API Router.

const PORTABLE_RESPONSE_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

// Flag-off secret and bearer check: the same secret sources, token format and
// answers as the inline getAuthSecret/verifyBearer of the History and Analysis
// API Router nodes. With scoped access off nothing on these routes loads the
// scope helper (contract of scripts/verify-auth-flag-off-hermetic.js).
function portableAuthSecret(request) {
  const configured = String(request.authSecret || '').trim();
  if (configured) return configured;
  const fsMod = request.fs;
  const warn = typeof request.warn === 'function' ? request.warn : function() {};
  const secretPaths = ['/data/db/osi_auth_token_secret', '/var/lib/node-red/.node-red/osi_auth_token_secret'];
  if (fsMod) {
    for (const secretPath of secretPaths) {
      try {
        const existing = String(fsMod.readFileSync(secretPath, 'utf8') || '').trim();
        if (existing) return existing;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          warn('portable history auth secret read failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
        }
      }
    }
    const generated = crypto.randomBytes(48).toString('hex');
    for (const secretPath of secretPaths) {
      try {
        fsMod.writeFileSync(secretPath, generated + '\n', { mode: 0o600 });
        return generated;
      } catch (error) {
        warn('portable history auth secret write failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
      }
    }
  }
  httpError(500, 'AUTH_TOKEN_SECRET or JWT_SECRET must be configured');
}

function portableVerifyBearer(authHeader, request) {
  if (!authHeader || !String(authHeader).startsWith('Bearer ')) httpError(401, 'Unauthorized');
  const parts = String(authHeader).substring(7).trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) httpError(401, 'Invalid token');
  const expected = crypto.createHmac('sha256', portableAuthSecret(request)).update(parts[0]).digest('base64url');
  const actualBuffer = Buffer.from(parts[1], 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    httpError(401, 'Invalid token');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (_) {
    httpError(401, 'Invalid token');
  }
  const userId = Number(payload && payload.userId);
  const username = String(payload && payload.username || '').trim();
  const exp = Number(payload && payload.exp || 0);
  if (!Number.isFinite(userId) || !username) httpError(401, 'Invalid token');
  if (exp && Date.now() > exp) httpError(401, 'Token expired');
  return { userId, username };
}

function portableRows(db, sql, params) {
  return new Promise(function(resolve, reject) {
    db.all(sql, params || [], function(error, rows) {
      if (error) return reject(error);
      return resolve(rows || []);
    });
  });
}

// Scoped mode: the token's subject must still be this account (id and
// username, as the History API Router checks) and enabled, read fresh here and
// decided by the scope helper.
// Flag off: the token's user must still exist, as the Analysis API Router
// checks (401 User not found).
async function portableAssertUserExists(db, auth) {
  const users = await portableRows(db, 'SELECT id FROM users WHERE id = ? LIMIT 1', [auth.userId]);
  if (!users.length) httpError(401, 'User not found');
}

async function portableAssertEnabledAccount(db, scope, auth) {
  const users = await portableRows(db, 'SELECT user_uuid, disabled_at FROM users WHERE id = ? AND username = ? LIMIT 1', [auth.userId, auth.username]);
  const user = users[0];
  if (!user || user.disabled_at) httpError(403, 'forbidden');
  await scope.assertEnabledAccount(db, user.user_uuid, { scopedMode: true });
}

// One all-zones export at a time per Node-RED process: an export near its row
// bound holds about 100-140 MB of heap and seconds of event-loop time, and
// its queries queue on the shared database connection ahead of ingest. The
// slot is released when the export finishes, whatever the outcome; a client
// that disconnects early frees it when the build it started completes.
let portableExportInFlight = false;

async function portableAllZonesExport(request, history, db, auth, scope) {
  const query = request.query || {};
  if (scope) {
    await portableAssertEnabledAccount(db, scope, auth);
  } else {
    await portableAssertUserExists(db, auth);
  }
  if (query.scope !== 'allZones') httpError(400, 'Unsupported export scope', 'use scope=allZones');
  if (portableExportInFlight) {
    const busy = new Error('export already running');
    busy.statusCode = 429;
    busy.suggestion = 'try again when the current export finishes';
    busy.headers = { 'Retry-After': '30' };
    throw busy;
  }
  portableExportInFlight = true;
  try {
    return await portableBuildAllZonesExport(request, history, db, auth, scope, query);
  } finally {
    portableExportInFlight = false;
  }
}

async function portableBuildAllZonesExport(request, history, db, auth, scope, query) {
  // Scoped mode, write-only scoping (W1): zone history is account-wide for
  // every enabled account, as on the per-zone history routes. Flag off: the
  // caller's own zones, as the per-zone routes resolve them.
  const zoneRows = scope
    ? await portableRows(db, 'SELECT id FROM irrigation_zones WHERE deleted_at IS NULL ORDER BY id ASC', [])
    : await portableRows(db, 'SELECT id FROM irrigation_zones WHERE user_id = ? AND deleted_at IS NULL ORDER BY id ASC', [auth.userId]);
  const granularity = String(query.granularity || 'daily').trim().toLowerCase() || 'daily';
  const from = String(query.from || '').trim();
  const to = String(query.to || query.from || '').trim();
  const result = await history.buildAllZonesExportCsv(db, {
    zoneIds: zoneRows.map(function(row) { return Number(row.id); }),
    from: from,
    to: to,
    granularity: granularity,
    channels: String(query.channels || '').trim(),
    site: String(request.site || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN',
    nowMs: request.nowMs || Date.now()
  });
  const filename = 'all-zones-' + safeFilenamePart(from, 'from') + '_' + safeFilenamePart(to, 'to') + '-' + safeFilenamePart(granularity, 'daily') + '.csv';
  return {
    statusCode: 200,
    headers: Object.assign({}, PORTABLE_RESPONSE_HEADERS, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + safeFilenamePart(filename, 'all-zones-export.csv') + '"'
    }),
    payload: result.csv,
    rowCount: result.rowCount
  };
}

async function portableDeleteAnalysisView(request, history, db, auth, scope, viewId) {
  if (scope) {
    await portableAssertEnabledAccount(db, scope, auth);
  } else {
    await portableAssertUserExists(db, auth);
  }
  // Saved views are per user in every mode: the delete is filtered by owner.
  await history.deleteAnalysisView(db, { userId: auth.userId }, viewId);
  return { statusCode: 204, headers: PORTABLE_RESPONSE_HEADERS, payload: '' };
}

async function handlePortableHistoryRequest(request = {}) {
  try {
    const method = String(request.method || '').toUpperCase();
    const requestPath = String(request.path || '').split('?')[0];
    const history = request.history || historyHelper;
    const db = request.db;
    const scope = request.scopedMode === true ? request.scope : null;
    if (request.scopedMode === true && (!scope || typeof scope.verifyBearer !== 'function')) {
      httpError(500, 'scope resolver unavailable');
    }
    const auth = scope
      ? scope.verifyBearer(request.authorization, { configuredSecret: request.authSecret, fs: request.fs, warn: request.warn })
      : portableVerifyBearer(request.authorization, request);
    if (!db) httpError(500, 'database unavailable');
    if (method === 'GET' && requestPath === '/api/history/export.csv') {
      return await portableAllZonesExport(request, history, db, auth, scope);
    }
    const viewMatch = /^\/api\/analysis\/views\/([^/]+)$/.exec(requestPath);
    if (method === 'DELETE' && viewMatch) {
      const viewId = request.params && request.params.id !== undefined ? request.params.id : decodeURIComponent(viewMatch[1]);
      return await portableDeleteAnalysisView(request, history, db, auth, scope, viewId);
    }
    httpError(404, 'Endpoint not found');
  } catch (error) {
    const payload = { error: error && error.message ? error.message : 'Unexpected error' };
    if (error && error.detail !== undefined) payload.detail = error.detail;
    if (error && error.suggestion) payload.suggestion = error.suggestion;
    return {
      statusCode: error && (error.statusCode || error.status) ? (error.statusCode || error.status) : 500,
      headers: error && error.headers ? Object.assign({}, PORTABLE_RESPONSE_HEADERS, error.headers) : PORTABLE_RESPONSE_HEADERS,
      payload: payload
    };
  }
}

module.exports = {
  handlePortableHistoryRequest,
  safeFilenamePart,
  httpError,
  parseZoneId,
  boolValue,
  numberOrNull,
  parseJsonObject,
  sortIsoDesc,
  latestIso,
  supportedRangesForCard,
  seasonBoundaryIso,
  seasonRangeForContext,
  parseRangeSelection,
  validateView,
  validateAggregation,
  isSoilSource,
  isEnvironmentSource,
  isIrrigationSource,
  isDendroSource,
  pointQuality,
  soilChannelDepths,
  seriesWithDepth,
  buildSeriesFromAggregate,
  truncateSeries,
  latestPointTimestamp,
  latestValueBySeries,
  latestBatteryMetric,
  lastOpenedRankMap,
  buildPreferenceMap,
  normalizeWorkspaceRow,
  summaryScore,
  shouldUseHistoryRollups,
  shouldUseCardRollups,
  rowHasSoilProfileValue,
  latestSeriesPoint,
  pointValueForCalendar,
  calendarRowsFromSeries,
  latestCalendarState,
  advancedField,
  knownAvailableFields,
  phaseSummary,
  displayDeviceName,
  displaySourceLabels,
};
