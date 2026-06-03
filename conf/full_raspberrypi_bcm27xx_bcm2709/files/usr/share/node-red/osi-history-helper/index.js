'use strict';

const crypto = require('crypto');

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
  'ambient_temperature',
  'relative_humidity',
  'ext_temperature_c',
  'light_lux',
  'rain_mm_per_hour',
  'rain_mm_per_10min',
  'rain_mm_today',
  'rain_mm_delta',
  'rain_count_cumulative',
  'rain_tips_delta',
  'flow_count_cumulative',
  'flow_pulses_delta',
  'flow_liters_delta',
  'flow_liters_per_min',
  'flow_liters_per_10min',
  'flow_liters_today',
  'counter_interval_seconds',
  'wind_speed_mps',
  'wind_direction_deg',
  'wind_gust_mps',
  'barometric_pressure_hpa',
  'rain_gauge_cumulative_mm',
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
]);

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

function parseTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
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

function deviceBelongsToZone(device, zone) {
  if (!device || !zone) return false;
  const zoneId = toFiniteNumber(zone.id ?? zone.zone_id);
  const deviceZoneId = toFiniteNumber(device.irrigation_zone_id || device.zone_id);
  if (zoneId !== null) return deviceZoneId === zoneId;
  const zoneUuid = String(zone.zone_uuid || zone.zoneUuid || '').trim();
  const deviceZoneUuid = String(device.irrigation_zone_uuid || device.zone_uuid || device.zoneUuid || '').trim();
  return !!zoneUuid && !!deviceZoneUuid && zoneUuid === deviceZoneUuid;
}

function isSoilSource(device) {
  const type = String(device && device.type_id || '').toUpperCase();
  return ['KIWI_SENSOR', 'TEKTELIC_CLOVER'].includes(type)
    || Number(device && device.chameleon_enabled || 0) === 1
    || hasNumber(device, ['swt_1', 'swt_2', 'swt_3', 'swt_wm1', 'swt_wm2']);
}

function isEnvironmentSource(device) {
  const type = String(device && device.type_id || '').toUpperCase();
  return ['KIWI_SENSOR', 'TEKTELIC_CLOVER', 'SENSECAP_S2120'].includes(type)
    || (type === 'DRAGINO_LSN50' && Number(device && device.temp_enabled || 0) === 1)
    || hasNumber(device, ['ambient_temperature', 'relative_humidity', 'ext_temperature_c', 'light_lux', 'rain_mm_today']);
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

function channelsForCard(card) {
  const cardType = normalizeCardType(card && card.cardType);
  if (cardType === 'soil') {
    return [
      { id: 'swt_1', field: 'swt_1', unit: 'kPa' },
      { id: 'swt_2', field: 'swt_2', unit: 'kPa' },
      { id: 'swt_3', field: 'swt_3', unit: 'kPa' },
      { id: 'swt_wm1', field: 'swt_wm1', unit: 'kPa' },
      { id: 'swt_wm2', field: 'swt_wm2', unit: 'kPa' },
    ];
  }
  if (cardType === 'environment') {
    return [
      { id: 'ambient_temperature', field: 'ambient_temperature', unit: 'C' },
      { id: 'relative_humidity', field: 'relative_humidity', unit: '%' },
      { id: 'ext_temperature_c', field: 'ext_temperature_c', unit: 'C' },
      { id: 'light_lux', field: 'light_lux', unit: 'lux' },
      { id: 'rain_mm_per_hour', field: 'rain_mm_per_hour', unit: 'mm/h' },
      { id: 'rain_mm_per_10min', field: 'rain_mm_per_10min', unit: 'mm/10min' },
      { id: 'rain_mm_today', field: 'rain_mm_today', unit: 'mm' },
      { id: 'rain_mm_delta', field: 'rain_mm_delta', unit: 'mm' },
      { id: 'wind_speed_mps', field: 'wind_speed_mps', unit: 'm/s' },
      { id: 'wind_gust_mps', field: 'wind_gust_mps', unit: 'm/s' },
      { id: 'barometric_pressure_hpa', field: 'barometric_pressure_hpa', unit: 'hPa' },
      { id: 'uv_index', field: 'uv_index', unit: null },
    ];
  }
  if (cardType === 'dendro') {
    return [
      { id: 'dendro_stem_change_um', field: 'dendro_stem_change_um', unit: 'um' },
      { id: 'dendro_position_mm', field: 'dendro_position_mm', unit: 'mm' },
      { id: 'dendro_position_raw_mm', field: 'dendro_position_raw_mm', unit: 'mm' },
      { id: 'dendro_delta_mm', field: 'dendro_delta_mm', unit: 'mm' },
      { id: 'dendro_ratio', field: 'dendro_ratio', unit: null },
      { id: 'adc_ch0v', field: 'adc_ch0v', unit: 'V' },
      { id: 'adc_ch1v', field: 'adc_ch1v', unit: 'V' },
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
      if (typeof channel === 'string') return { id: channel, field: channel };
      if (!channel || typeof channel !== 'object') return null;
      return { id: channel.id || channel.field, field: channel.field || channel.id, unit: channel.unit || null };
    })
    .filter((channel) => channel && channel.id && channel.field);
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
      if (sourceKey && channel) addSourceChannelSample(samples, sourceKey, channel);
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
      for (const channel of channels) addSourceChannelSample(samples, sourceKey, channel);
    }
  }
}

function seedRequestedSourceChannelSamples(samples, channels, options = {}) {
  for (const sourceKey of requestedSourceKeys(options)) {
    for (const channel of channels) addSourceChannelSample(samples, sourceKey, channel);
  }
}

function sourceChannelSamples(sortedRows, channels) {
  const samples = new Map();
  for (const entry of sortedRows) {
    for (const channel of channels) {
      if (toFiniteNumber(entry.row[channel.field]) === null) continue;
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
      if (toFiniteNumber(entry.row[channel.field]) === null) continue;
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

function aggregateRows(rows, options = {}) {
  const aggregationInfo = resolveAggregation(options);
  const aggregation = aggregationInfo.level;
  const aggregationRequested = options.aggregationRequested || aggregationInfo.requested;
  const channels = normalizeChannels(options.channels);
  const startMs = parseTime(options.start || options.startAt || options.from);
  const endMs = parseTime(options.end || options.endAt || options.to);
  if (channels.length === 0) throw new Error('aggregateRows requires at least one channel');

  const sortedRows = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ row, recordedAtMs: parseTime(row.recorded_at || row.recordedAt) }))
    .filter((entry) => entry.recordedAtMs !== null)
    .filter((entry) => (startMs === null || entry.recordedAtMs >= startMs) && (endMs === null || entry.recordedAtMs < endMs))
    .sort((a, b) => a.recordedAtMs - b.recordedAtMs);

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
          .map((entry) => ({ recordedAt: new Date(entry.recordedAtMs).toISOString(), value: toFiniteNumber(entry.row[channel.field]) }))
          .filter((point) => point.value !== null),
      };
    }
    return {
      aggregation: 'raw',
      aggregationRequested,
      bucketSizeSeconds: null,
      source: 'device_data',
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

  const buckets = [];
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

  for (const bucket of buckets) {
    const bucketRows = sortedRows.filter((entry) => entry.recordedAtMs >= bucket.bucketStartMs && entry.recordedAtMs < bucket.bucketEndMs);
    for (const channel of channels) {
      const stats = statsForValues(bucketRows.map((entry) => ({ value: entry.row[channel.field], recordedAtMs: entry.recordedAtMs })));
      bucket.series[channel.id] = stats ? { ...stats, unit: channel.unit || null } : {
        min: null,
        max: null,
        mean: null,
        median: null,
        latest: null,
        sampleCount: 0,
        unit: channel.unit || null,
      };
      bucket.sampleCount += bucket.series[channel.id].sampleCount;
    }
    const coverage = coverageForBucket(bucketRows, channels, sourceCadences, (bucket.bucketEndMs - bucket.bucketStartMs) / 1000);
    bucket.coveragePct = coverage.coveragePct;
    bucket.coverageConfidence = coverage.coverageConfidence;
    delete bucket.bucketStartMs;
    delete bucket.bucketEndMs;
  }

  const totalSamples = buckets.reduce((sum, bucket) => sum + bucket.sampleCount, 0);
  const totalSeconds = (endMs - startMs) / 1000;
  const totalCoverage = coverageForBucket(sortedRows, channels, sourceCadences, totalSeconds);
  return {
    aggregation,
    aggregationRequested,
    bucketSizeSeconds: aggregationInfo.bucketSizeSeconds,
    source: 'device_data',
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
    if (!ALLOWED_DEVICE_DATA_CHANNELS.has(channel.field)) throw new Error(`unsupported device_data channel: ${channel.field}`);
  }
  return normalized;
}

async function computeRollupBuckets(db, scope = {}, level, windowMs, nowMs) {
  const aggregation = String(level || '').trim();
  if (!['hourly', 'daily', 'weekly'].includes(aggregation)) throw new Error(`unsupported rollup level: ${level}`);
  const channels = normalizeQueryChannels(scope.channels);
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
  const selectedFields = Array.from(new Set(channels.map((channel) => channel.field)));
  const sql = `SELECT deveui, recorded_at, ${selectedFields.join(', ')} FROM device_data WHERE deveui IN (${placeholders}) AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at ASC`;
  const rows = await dbAll(db, sql, deveuis.concat([start, end]));
  const result = aggregateRows(rows, { aggregation, channels, start, end, expectedCadences: scope.expectedCadences || scope.expected_cadences });
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

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  return /[",\n\r]/.test(stringValue) ? '"' + stringValue.replace(/"/g, '""') + '"' : stringValue;
}

function toCsv(columns, rows) {
  const safeColumns = Array.isArray(columns) ? columns : [];
  const safeRows = Array.isArray(rows) ? rows : [];
  return [safeColumns.join(',')]
    .concat(safeRows.map((row) => safeColumns.map((column) => csvCell(row && row[column])).join(',')))
    .join('\n') + '\n';
}

const RAW_CSV_COLUMNS = ['timestamp', 'timezone', 'zone', 'card', 'source', 'variable', 'depth_cm', 'value', 'unit'];
const AGG_CSV_COLUMNS = ['bucket_start', 'bucket_end', 'timezone', 'zone', 'card', 'source', 'variable', 'depth_cm', 'unit', 'n', 'coverage_pct', 'mean', 'min', 'max', 'median', 'latest'];

function normalizeExportDate(value, name) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
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

function assertExportRangeAllowed(scope) {
  const days = exportSpanDays(scope.from, scope.to);
  const maxDays = scope.granularity === 'raw' ? 92 : (scope.granularity === 'hourly' ? 730 : null);
  if (maxDays !== null && days > maxDays) {
    const error = new Error('range too large for this granularity');
    error.code = 'RANGE_TOO_LARGE';
    error.statusCode = 413;
    error.suggestion = 'choose a coarser granularity';
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
  if ((today && from > today) || (today && to > today)) {
    const error = new Error('date range cannot include future days');
    error.statusCode = 400;
    throw error;
  }

  const start = zoneDateStartIso(from, timezone);
  const end = zoneDateStartIso(addIsoDays(to, 1), timezone);
  const devices = await dbAll(db, 'SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ? ORDER BY deveui ASC', [zoneId]);
  const cards = deriveCardsForZone(zone, devices).filter((card) => normalizeCardType(card.cardType) !== 'gateway');
  return { zone, timezone, from, to, start, end, devices, cards, granularity: normalizeExportGranularity(options.granularity), nowMs: options.nowMs ?? Date.now() };
}

async function rawZoneExportRows(db, scope) {
  const rows = [];
  const zoneName = String(scope.zone.name || scope.zone.zone_uuid || scope.zone.id);
  for (const card of scope.cards) {
    const channels = channelsForCard(card);
    const sourceDevices = sourceDevicesForCard(card, scope.devices)
      .slice()
      .sort((left, right) =>
        String(normalizeDeveui(left.deveui || left.device_eui) || '').localeCompare(String(normalizeDeveui(right.deveui || right.device_eui) || ''))
      );
    const deveuis = uniqueDeveuis(sourceDevices);
    if (!channels.length || !deveuis.length) continue;

    const selectedFields = Array.from(new Set(channels.map((channel) => channel.field)));
    const placeholders = deveuis.map(() => '?').join(',');
    const sql = `SELECT deveui, recorded_at, ${selectedFields.join(', ')} FROM device_data WHERE deveui IN (${placeholders}) AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at ASC`;
    const dataRows = await dbAll(db, sql, deveuis.concat([scope.start, scope.end]));
    const rowsByDeveui = {};
    for (const row of dataRows) {
      const key = normalizeDeveui(row.deveui);
      if (!key) continue;
      if (!rowsByDeveui[key]) rowsByDeveui[key] = [];
      rowsByDeveui[key].push(row);
    }

    sourceDevices.forEach((device, index) => {
      const deveui = normalizeDeveui(device.deveui || device.device_eui);
      const sourceRows = rowsByDeveui[deveui] || [];
      const sourceName = displayDeviceName(device, index);
      for (const row of sourceRows) {
        for (const channel of channels) {
          const value = toFiniteNumber(row[channel.field]);
          if (value === null) continue;
          rows.push({
            timestamp: row.recorded_at,
            timezone: scope.timezone,
            zone: zoneName,
            card: card.cardType,
            source: sourceName,
            variable: channel.id,
            depth_cm: soilDepthCm(device, channel.id),
            value: roundTo(value),
            unit: channel.unit || null,
          });
        }
      }
    });
  }
  rows.sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp))
    || String(left.card).localeCompare(String(right.card))
    || String(left.source).localeCompare(String(right.source))
    || String(left.variable).localeCompare(String(right.variable)));
  return rows;
}

async function aggregateZoneExportRows(db, scope) {
  const rows = [];
  const zoneName = String(scope.zone.name || scope.zone.zone_uuid || scope.zone.id);
  for (const card of scope.cards) {
    const channels = channelsForCard(card);
    const sourceDevices = sourceDevicesForCard(card, scope.devices)
      .slice()
      .sort((left, right) =>
        String(normalizeDeveui(left.deveui || left.device_eui) || '').localeCompare(String(normalizeDeveui(right.deveui || right.device_eui) || ''))
      );
    if (!channels.length || !sourceDevices.length) continue;

    let index = 0;
    for (const device of sourceDevices) {
      const sourceName = displayDeviceName(device, index);
      index += 1;
      const deveui = normalizeDeveui(device.deveui || device.device_eui);
      if (!deveui) continue;
      const aggregate = await aggregateDeviceData(db, {
        zoneId: scope.zone.id,
        cardType: card.cardType,
        logicalSourceKey: card.logicalSourceKey,
        device_euis: [deveui],
        sourceFilterActive: true,
        start: scope.start,
        end: scope.end,
        aggregation: scope.granularity,
        channels,
        timezone: scope.timezone,
        nowMs: scope.nowMs,
      });
      rows.push(...csvRowsFromAggregate(aggregate, card, device, sourceName, channels).map((row) => ({
        ...row,
        timezone: scope.timezone,
        zone: zoneName,
      })));
    }
  }
  rows.sort((left, right) => String(left.bucket_start).localeCompare(String(right.bucket_start))
    || String(left.card).localeCompare(String(right.card))
    || String(left.source).localeCompare(String(right.source))
    || String(left.variable).localeCompare(String(right.variable)));
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
  const timezone = normalizeTimezone(zone.timezone);
  const zoneName = String(zone.name || zoneUuid);
  const stamp = (row) => ({ ...(row || {}), timezone, zone: zoneName });

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

function csvRowsFromAggregate(aggregate, card, device, sourceName, channels) {
  const rows = [];
  for (const bucket of aggregate.buckets || []) {
    for (const channel of channels) {
      const stats = bucket.series && bucket.series[channel.id];
      if (!stats || Number(stats.sampleCount || 0) === 0) continue;
      rows.push({
        bucket_start: bucket.bucketStart,
        bucket_end: bucket.bucketEnd,
        card: card.cardType,
        source: sourceName,
        variable: channel.id,
        depth_cm: soilDepthCm(device, channel.id),
        unit: channel.unit || stats.unit || null,
        n: Number(stats.sampleCount || 0),
        coverage_pct: bucket.coveragePct,
        mean: stats.mean,
        min: stats.min,
        max: stats.max,
        median: stats.median,
        latest: stats.latest,
      });
    }
  }
  return rows;
}

async function buildZoneCsvRows(db, zone, devices, cards, dayStartIso, dayEndIso) {
  const rawRows = [];
  const hourlyRows = [];
  const dailyRows = [];
  for (const card of cards || []) {
    const channels = channelsForCard(card);
    const sourceDevices = sourceDevicesForCard(card, devices)
      .slice()
      .sort((left, right) =>
        String(normalizeDeveui(left.deveui || left.device_eui) || '').localeCompare(String(normalizeDeveui(right.deveui || right.device_eui) || ''))
      );
    const deveuis = uniqueDeveuis(sourceDevices);
    if (!channels.length || !deveuis.length) continue;
    const selectedFields = Array.from(new Set(channels.map((channel) => channel.field)));
    const placeholders = deveuis.map(() => '?').join(',');
    const sql = `SELECT deveui, recorded_at, ${selectedFields.join(', ')} FROM device_data WHERE deveui IN (${placeholders}) AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at ASC`;
    const rows = await dbAll(db, sql, deveuis.concat([dayStartIso, dayEndIso]));
    const rowsByDeveui = {};
    for (const row of rows) {
      const key = normalizeDeveui(row.deveui);
      if (!key) continue;
      if (!rowsByDeveui[key]) rowsByDeveui[key] = [];
      rowsByDeveui[key].push(row);
    }

    sourceDevices.forEach((device, index) => {
      const deveui = normalizeDeveui(device.deveui || device.device_eui);
      const sourceRows = rowsByDeveui[deveui] || [];
      const sourceName = displayDeviceName(device, index);
      for (const row of sourceRows) {
        for (const channel of channels) {
          const value = toFiniteNumber(row[channel.field]);
          if (value === null) continue;
          rawRows.push({
            timestamp: row.recorded_at,
            card: card.cardType,
            source: sourceName,
            variable: channel.id,
            depth_cm: soilDepthCm(device, channel.id),
            value: roundTo(value),
            unit: channel.unit || null,
          });
        }
      }
      const hourly = aggregateRows(sourceRows, { aggregation: 'hourly', channels, start: dayStartIso, end: dayEndIso });
      hourlyRows.push(...csvRowsFromAggregate(hourly, card, device, sourceName, channels));
      const daily = aggregateRows(sourceRows, { aggregation: 'daily', channels, start: dayStartIso, end: dayEndIso });
      dailyRows.push(...csvRowsFromAggregate(daily, card, device, sourceName, channels));
    });
  }
  return { rawRows, hourlyRows, dailyRows };
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
      const devices = await dbAll(db, 'SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ?', [zone.id]);
      const cards = deriveCardsForZone(zone, devices);
      for (const card of cards) {
        const channels = channelsForCard(card);
        const sourceDevices = sourceDevicesForCard(card, devices);
        const deveuis = uniqueDeveuis(sourceDevices);
        if (!channels.length || !deveuis.length) continue;
        cardsProcessed += 1;
        const scope = {
          zoneId: zone.id,
          cardType: card.cardType,
          logicalSourceKey: card.logicalSourceKey,
          channels,
          deveuis,
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
        const dayStartIso = new Date(dayStartMs).toISOString();
        const dayEndIso = new Date(dayEndMs).toISOString();
        const day = localDateKey(dayStartMs, timezone);
        const csvRows = await buildZoneCsvRows(db, zone, devices, cards, dayStartIso, dayEndIso);
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

function rollupRowsToResult(rows, query, channels) {
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

function canonicalHistoryField(field) {
  const normalized = String(field || '').trim();
  return LEGACY_FIELD_ALIASES[normalized] || normalized;
}

function legacyFieldExpression(field) {
  const normalized = String(field || '').trim();
  if (!ALLOWED_DEVICE_DATA_CHANNELS.has(normalized)) return null;
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
  const devices = await dbAll(db, `SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ?${zoneDeviceFilter.sql} ORDER BY deveui ASC`, [device.zone_id].concat(zoneDeviceFilter.params));
  const cards = deriveCardsForZone(zone, devices);
  for (const card of cards) {
    const channel = channelsForCard(card).find((candidate) =>
      candidate.id === rollupField || candidate.field === rollupField
    );
    if (!channel) continue;
    const sourceDevices = sourceDevicesForCard(card, devices);
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
  const rows = await dbAll(db, `
    SELECT dd.recorded_at, ${expression} AS value
    FROM device_data dd
    JOIN devices dv ON dv.deveui = dd.deveui
    WHERE dd.deveui = ?
      ${ownerFilter.sql}
      AND ${expression} IS NOT NULL
      AND dd.recorded_at >= ?
      AND dd.recorded_at < ?
    ORDER BY dd.recorded_at ASC
    LIMIT ?
  `, [normalizedDeveui].concat(ownerFilter.params, [start, end, limit]));
  return rows.map((row) => ({ t: row.recorded_at, value: toFiniteNumber(row.value) }));
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
      if (value !== null) points.push({ t: point.t || point.recorded_at, value });
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
      AND dd.recorded_at >= ?
      AND dd.recorded_at < ?
      AND (dd.dendro_position_mm IS NOT NULL OR dd.adc_ch0v IS NOT NULL OR dd.adc_ch1v IS NOT NULL OR dd.dendro_ratio IS NOT NULL)
    ORDER BY dd.recorded_at ASC
    LIMIT 30000
  `, [normalizedDeveui].concat(ownerFilter.params, [start, end]));
  return rows.map(dendroHistoryRow);
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

async function aggregateDeviceData(db, query = {}) {
  const aggregationInfo = resolveAggregation(query);
  const aggregation = aggregationInfo.level;
  const channels = normalizeQueryChannels(query.channels);
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
      const selectedFields = Array.from(new Set(channels.map((channel) => channel.field)));
      const sql = `SELECT deveui, recorded_at, ${selectedFields.join(', ')} FROM device_data WHERE deveui IN (${livePlaceholders}) AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at ASC`;
      const rows = await dbAll(db, sql, deveuis.concat([splitIso, end]));
      live = aggregateRows(rows, { ...query, aggregation, aggregationRequested: aggregationInfo.requested, channels, start: splitIso, end });
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
  const selectedFields = Array.from(new Set(channels.map((channel) => channel.field)));
  const sql = `SELECT deveui, recorded_at, ${selectedFields.join(', ')} FROM device_data WHERE deveui IN (${placeholders}) AND recorded_at BETWEEN ? AND ? ORDER BY deveui ASC, recorded_at ASC`;
  const params = deveuis.concat([start, end]);
  const rows = await dbAll(db, sql, params);
  const result = aggregateRows(rows, { ...query, aggregation, aggregationRequested: aggregationInfo.requested, channels, start, end });
  if (shouldUseRollups) result.source = 'device_data_fallback';
  return result;
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

  if (coverageConfidence === 'unknown' || (coveragePct !== null && coveragePct < 80)) {
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

function normalizeTimezone(value) {
  const timezone = String(value || 'UTC').trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch (_) {
    return 'UTC';
  }
}

function startOfLocalDayMs(nowMs, timezone) {
  const instantMs = typeof nowMs === 'number' ? nowMs : parseTime(nowMs);
  if (instantMs === null) throw new Error('startOfLocalDayMs requires a valid instant');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(instantMs)).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const wallClockAsUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  // Floor to whole seconds so the sub-second remainder of `instantMs` does not leak
  // into the day boundary (which would make daily/weekly bucket_start jitter per run).
  const instantSecMs = Math.floor(instantMs / 1000) * 1000;
  const offsetMs = wallClockAsUtcMs - instantSecMs;
  const localMidnightAsUtcMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0);
  return localMidnightAsUtcMs - offsetMs;
}

function localDateKey(value, timezone) {
  const ms = typeof value === 'number' ? value : parseTime(value);
  if (ms === null) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
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

module.exports = {
  normalizeDeveui,
  deriveCardId,
  deriveCardsForZone,
  deriveGatewayCard,
  resolveAggregation,
  classifySoilStatus,
  classifySoilDay,
  classifyEnvironmentStatus,
  classifyDendroStatus,
  classifyIrrigationStatus,
  classifyGatewayStatus,
  deriveExpectedCadenceSeconds,
  startOfLocalDayMs,
  computeRollupBuckets,
  upsertRollups,
  runRollupJob,
  resolveDeviceFieldRollupKey,
  legacySensorHistory,
  buildZoneExportCsv,
  RAW_CSV_COLUMNS,
  AGG_CSV_COLUMNS,
  toCsv,
  writeZoneCsv,
  rotateZoneCsv,
  aggregateRows,
  aggregateDeviceData,
  buildAdvancedMetadataPlaceholder,
  buildAdvancedDiagnostics,
  buildCalendar,
  buildLocalInterpretations,
};
