'use strict';

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
  const typeId = String(device && device.type_id || '').toUpperCase();
  return typeId === 'KIWI_SENSOR' || typeId === 'TEKTELIC_CLOVER' || Number(device && device.chameleon_enabled || 0) === 1;
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

function pointQuality(coveragePct) {
  if (coveragePct === null || coveragePct === undefined) return 'unknown';
  if (coveragePct >= 90) return 'ok';
  if (coveragePct >= 50) return 'partial';
  if (coveragePct > 0) return 'gap';
  return 'gap';
}

function soilChannelDepths(sourceDevices) {
  const primaryDevice = (sourceDevices || [])[0] || {};
  return {
    swt_1: numberOrNull(primaryDevice.chameleon_swt1_depth_cm),
    swt_2: numberOrNull(primaryDevice.chameleon_swt2_depth_cm),
    swt_3: numberOrNull(primaryDevice.chameleon_swt3_depth_cm)
  };
}

function seriesWithDepth(series, depths, channelId) {
  const depthCm = depths && Object.prototype.hasOwnProperty.call(depths, channelId) ? depths[channelId] : null;
  return depthCm === null || depthCm === undefined ? series : Object.assign({}, series, { depthCm: depthCm });
}

function buildSeriesFromAggregate(card, aggregate, sourceDevices, opts) {
  var _statusForCardValue = opts && opts.statusForCardValue || function() { return null; };
  const channels = CARD_CONFIG[card.cardType].channels;
  const soilDepths = card.cardType === 'soil' ? soilChannelDepths(sourceDevices) : null;
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

module.exports = {
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
