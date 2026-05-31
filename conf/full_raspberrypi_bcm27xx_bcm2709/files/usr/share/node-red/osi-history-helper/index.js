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

const ALLOWED_AGGREGATIONS = new Set(['raw', '15m', 'hourly', 'daily', 'weekly']);

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
]);

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
  const zoneId = toFiniteNumber(zone.id);
  const deviceZoneId = toFiniteNumber(device.irrigation_zone_id || device.zone_id);
  if (zoneId !== null && deviceZoneId !== null) return zoneId === deviceZoneId;
  return true;
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

function deriveCardsForZone(zone, devices) {
  const zoneUuid = String(zone && (zone.zone_uuid || zone.zoneUuid) || '').trim();
  if (!zoneUuid) return [];
  const scopedDevices = (Array.isArray(devices) ? devices : []).filter((device) => deviceBelongsToZone(device, zone));
  const cards = [];

  const pushMerged = (cardType, predicate) => {
    const count = scopedDevices.filter(predicate).length;
    if (count > 0) {
      cards.push({
        id: deriveCardId({ zoneUuid, cardType }),
        cardType,
        logicalSourceKey: DEFAULT_SOURCE_KEYS[cardType],
        sourceDeviceCount: count,
      });
    }
  };

  pushMerged('soil', isSoilSource);
  for (const device of scopedDevices.filter(isDendroSource)) {
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
  const wetKpa = toFiniteNumber(thresholds.wetKpa) ?? 15;
  const dryKpa = toFiniteNumber(thresholds.dryKpa) ?? 70;
  const value = firstFinite(input, ['swtKpa', 'swt_kpa', 'value'])
    ?? meanFinite([input.swt_1, input.swt_2, input.swt_3, input.swt_wm1, input.swt_wm2]);

  if (value === null) return { status: 'no_data', severity: 'info', value: null };
  if (value >= dryKpa) return { status: 'dry_stress', severity: 'warning', value: roundTo(value), thresholds: { wetKpa, dryKpa } };
  if (value <= wetKpa) return { status: 'wet_excess', severity: 'warning', value: roundTo(value), thresholds: { wetKpa, dryKpa } };
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
  const deltas = [];
  for (let index = 1; index < times.length; index += 1) {
    const deltaSeconds = (times[index] - times[index - 1]) / 1000;
    if (deltaSeconds > 0) deltas.push(deltaSeconds);
  }
  const medianDelta = median(deltas);
  if (medianDelta !== null && medianDelta > 0) {
    return { seconds: Math.round(medianDelta), confidence: 'derived' };
  }
  return { seconds: null, confidence: 'unknown' };
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

function configuredCadenceFor(options, sourceKey, channel, key) {
  const maps = [
    options.expectedCadences,
    options.expectedCadenceBySource,
    options.expectedCadenceSecondsBySource,
    options.expected_cadences,
  ].filter((value) => value && typeof value === 'object');
  const candidates = [key, `${sourceKey}|${channel.field}`, sourceKey, channel.id, channel.field];
  for (const map of maps) {
    for (const candidate of candidates) {
      if (Object.prototype.hasOwnProperty.call(map, candidate)) {
        const value = map[candidate];
        const seconds = toFiniteNumber(value && typeof value === 'object' ? value.seconds : value);
        if (seconds !== null && seconds > 0) return Math.round(seconds);
      }
    }
  }
  const fallback = toFiniteNumber(options.expectedCadenceSeconds ?? options.configuredCadenceSeconds);
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

function cadenceFromTimes(times) {
  const sorted = times.slice().sort((a, b) => a - b);
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
    const derived = allowDerived ? cadenceFromTimes(sample.times) : null;
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

function normalizeQueryChannels(channels) {
  const normalized = normalizeChannels(channels);
  if (normalized.length === 0) throw new Error('aggregateDeviceData requires channels');
  for (const channel of normalized) {
    if (!ALLOWED_DEVICE_DATA_CHANNELS.has(channel.field)) throw new Error(`unsupported device_data channel: ${channel.field}`);
  }
  return normalized;
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

async function aggregateDeviceData(db, query = {}) {
  const aggregationInfo = resolveAggregation(query);
  const aggregation = aggregationInfo.level;
  const channels = normalizeQueryChannels(query.channels);
  const start = query.start || query.startAt || query.from;
  const end = query.end || query.endAt || query.to;
  if (!start || !end) throw new Error('aggregateDeviceData requires start and end');

  const hasRollupIdentity = query.zoneId !== undefined && query.cardType && query.logicalSourceKey;
  const shouldUseRollups = query.useRollups === true || (query.useRollups !== false && hasRollupIdentity && ['daily', 'weekly'].includes(aggregation));
  if (shouldUseRollups) {
    const channelIds = channels.map((channel) => channel.id);
    const placeholders = channelIds.map(() => '?').join(',');
    const sql = `SELECT * FROM history_channel_rollups WHERE zone_id = ? AND card_type = ? AND logical_source_key = ? AND bucket_level = ? AND bucket_start >= ? AND bucket_start < ? AND channel_id IN (${placeholders}) ORDER BY bucket_start ASC, channel_id ASC`;
    const params = [query.zoneId, query.cardType, query.logicalSourceKey, aggregation, start, end].concat(channelIds);
    const rows = await dbAll(db, sql, params);
    return rollupRowsToResult(rows, { ...query, aggregation, aggregationRequested: aggregationInfo.requested }, channels);
  }

  const deveuis = (Array.isArray(query.deveuis) ? query.deveuis : [query.deveui])
    .map(normalizeDeveui)
    .filter(Boolean);
  if (deveuis.length === 0) throw new Error('aggregateDeviceData requires at least one DevEUI');
  const placeholders = deveuis.map(() => '?').join(',');
  const selectedFields = Array.from(new Set(channels.map((channel) => channel.field)));
  const sql = `SELECT deveui, recorded_at, ${selectedFields.join(', ')} FROM device_data WHERE deveui IN (${placeholders}) AND recorded_at BETWEEN ? AND ? ORDER BY recorded_at ASC`;
  const params = deveuis.concat([start, end]);
  const rows = await dbAll(db, sql, params);
  return aggregateRows(rows, { ...query, aggregation, aggregationRequested: aggregationInfo.requested, channels, start, end });
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
  classifyEnvironmentStatus,
  classifyDendroStatus,
  classifyIrrigationStatus,
  classifyGatewayStatus,
  deriveExpectedCadenceSeconds,
  aggregateRows,
  aggregateDeviceData,
  buildAdvancedMetadataPlaceholder,
  buildLocalInterpretations,
};
