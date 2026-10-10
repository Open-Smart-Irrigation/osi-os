'use strict';

const { resolveKc } = require('../osi-crop-kc');

const LOCAL_METRICS = [
  { key: 'air_temperature_c', label: 'Air Temperature', unit: '°C', decimals: 2, aliases: ['ambient_temperature', 'air_temperature_c', 'temperature_2m', 'temp_c', 'temperature'] },
  { key: 'relative_humidity_pct', label: 'Relative Humidity', unit: '%', decimals: 1, aliases: ['relative_humidity', 'ambient_humidity', 'relative_humidity_pct', 'relative_humidity_2m', 'humidity'] },
  { key: 'probe_temperature_c', label: 'Probe Temperature', unit: '°C', decimals: 2, aliases: ['ext_temperature_c', 'probe_temperature_c'] },
  { key: 'pressure_hpa', label: 'Pressure', unit: 'hPa', decimals: 1, aliases: ['pressure_hpa', 'pressure', 'pressure_msl', 'surface_pressure', 'barometric_pressure', 'barometric_pressure_hpa', 'atmospheric_pressure'] },
  { key: 'wind_speed_mps', label: 'Wind Speed', unit: 'm/s', decimals: 2, aliases: ['wind_speed_mps', 'wind_speed', 'wind_speed_10m'] },
  { key: 'light_lux', label: 'Light', unit: 'lux', decimals: 0, aliases: ['light_lux', 'illuminance_lux', 'illuminance', 'light_intensity'] },
  { key: 'uv_index', label: 'UV Index', unit: 'UVI', decimals: 1, aliases: ['uv_index', 'uvi'] },
  { key: 'soil_temperature_c', label: 'Soil Temperature', unit: '°C', decimals: 2, aliases: ['soil_temperature_c', 'soil_temperature_0_to_7cm'] },
  { key: 'soil_moisture_pct', label: 'Soil Moisture', unit: '%', decimals: 2, aliases: ['soil_moisture_pct', 'soil_moisture_0_to_7cm'] }
];
const DEVICE_ONLY_METRICS = [
  { key: 'wind_direction_deg', label: 'Wind Direction', unit: '°', decimals: 1, aliases: ['wind_direction_deg', 'wind_direction', 'wind_direction_10m'] }
];

function trimToNull(value) {
  const trimmed = String(value == null ? '' : value).trim();
  return trimmed ? trimmed : null;
}

function normalizeTimezone(value) {
  const tz = trimToNull(value);
  if (!tz) return 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch (_) {
    return 'UTC';
  }
}

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value, decimals) {
  const numeric = toFiniteNumber(value);
  if (numeric == null) return null;
  const factor = Math.pow(10, Number(decimals || 0));
  return Math.round(numeric * factor) / factor;
}

function mean(values) {
  const filtered = (values || []).filter(v => v != null && Number.isFinite(Number(v))).map(Number);
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function median(values) {
  const filtered = (values || []).filter(v => v != null && Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (!filtered.length) return null;
  const mid = Math.floor(filtered.length / 2);
  if (filtered.length % 2) return filtered[mid];
  return (filtered[mid - 1] + filtered[mid]) / 2;
}

function minValue(values) {
  const filtered = (values || []).filter(v => v != null && Number.isFinite(Number(v))).map(Number);
  if (!filtered.length) return null;
  return Math.min.apply(null, filtered);
}

function maxValue(values) {
  const filtered = (values || []).filter(v => v != null && Number.isFinite(Number(v))).map(Number);
  if (!filtered.length) return null;
  return Math.max.apply(null, filtered);
}

function computeVPD(tempC, relativeHumidityPct) {
  const temp = toFiniteNumber(tempC);
  const rh = toFiniteNumber(relativeHumidityPct);
  if (temp == null || rh == null) return null;
  const saturationPressure = 0.6108 * Math.exp(17.27 * temp / (temp + 237.3));
  return saturationPressure * (1 - rh / 100);
}

function computeDewPoint(tempC, relativeHumidityPct) {
  const temp = toFiniteNumber(tempC);
  const rh = toFiniteNumber(relativeHumidityPct);
  if (temp == null || rh == null || rh <= 0 || rh > 100) return null;
  const a = 17.27;
  const b = 237.7;
  const gamma = (a * temp / (b + temp)) + Math.log(rh / 100);
  return (b * gamma) / (a - gamma);
}

function computeHeatIndexC(tempC, relativeHumidityPct) {
  const temp = toFiniteNumber(tempC);
  const rh = toFiniteNumber(relativeHumidityPct);
  if (temp == null || rh == null) return null;
  const tempF = temp * 9 / 5 + 32;
  if (tempF < 80 || rh < 40) return temp;
  const heatIndexF =
    -42.379 +
    2.04901523 * tempF +
    10.14333127 * rh -
    0.22475541 * tempF * rh -
    0.00683783 * tempF * tempF -
    0.05481717 * rh * rh +
    0.00122874 * tempF * tempF * rh +
    0.00085282 * tempF * rh * rh -
    0.00000199 * tempF * tempF * rh * rh;
  return (heatIndexF - 32) * 5 / 9;
}

function computeTHI(tempC, relativeHumidityPct) {
  const temp = toFiniteNumber(tempC);
  const rh = toFiniteNumber(relativeHumidityPct);
  if (temp == null || rh == null) return null;
  return temp - ((0.55 - 0.0055 * rh) * (temp - 14.5));
}

function maxInstant(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function safeJsonParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function toIsoTime(value) {
  const raw = trimToNull(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw + 'T00:00:00.000Z';
  }
  if (/Z$|[+-]\d{2}:\d{2}$/.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(raw + ':00Z');
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Open-Meteo times. With `timeformat=unixtime` a time is an instant in
// seconds. Otherwise it is a label without suffix under ONE fixed offset for
// the whole response (`utc_offset_seconds`, the requested zone's offset at the
// start of the response, kept across a DST change): never UTC, and not the
// zone's wall clock after a DST change. A label without a known offset is an
// unknown instant.
const NAIVE_LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function openMeteoInstantIso(value, utcOffsetSeconds) {
  let ms = NaN;
  if (typeof value === 'number') {
    ms = value * 1000;
  } else {
    const raw = trimToNull(value);
    if (!raw) return null;
    const offset = toFiniteNumber(utcOffsetSeconds);
    if (/Z$|[+-]\d{2}:\d{2}$/.test(raw)) ms = Date.parse(raw);
    else if (NAIVE_LOCAL_TIME.test(raw) && offset != null) ms = Date.parse(raw + 'Z') - offset * 1000;
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// A daily time is the provider's date label, or (unixtime) the instant of
// that day's start under the response offset. Without the offset, the
// requested zone dates the day's noon, which keeps the date for any offset
// error under 12 hours.
function openMeteoDateIso(value, utcOffsetSeconds, timezone) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const seconds = typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(seconds)) return null;
  const offset = toFiniteNumber(utcOffsetSeconds);
  if (offset != null) return new Date((seconds + offset) * 1000).toISOString().slice(0, 10);
  return localDateIso(seconds * 1000 + 12 * 3600000, timezone);
}

// Maps an Open-Meteo forecast response (hourly + daily) to the cached
// forecast shape. An hourly time stays the END of its interval: precipitation
// at T is the provider's sum for T-1h..T.
function parseOpenMeteoForecast(response, opts = {}) {
  const observedAtMs = opts.observedAtMs != null ? opts.observedAtMs : Date.now();
  const offset = response ? response.utc_offset_seconds : null;
  const hourly = (response && response.hourly) || {};
  const daily = (response && response.daily) || {};
  const at = (series, index) => (Array.isArray(series) ? series[index] : null);
  const hours = (Array.isArray(hourly.time) ? hourly.time : []).map((time, index) => ({
    time: openMeteoInstantIso(time, offset),
    airTemperatureC: round(at(hourly.temperature_2m, index), 2),
    relativeHumidityPct: round(at(hourly.relative_humidity_2m, index), 1),
    rainMm: round(at(hourly.precipitation, index), 2),
    precipitationProbabilityPct: round(at(hourly.precipitation_probability, index), 1),
    windSpeedMps: round(at(hourly.wind_speed_10m, index), 2),
    windDirectionDeg: round(at(hourly.wind_direction_10m, index), 1)
  })).filter((hour) => hour.time);
  const days = (Array.isArray(daily.time) ? daily.time : []).map((time, index) => {
    const probability = round(at(daily.precipitation_probability_max, index), 1);
    const minC = round(at(daily.temperature_2m_min, index), 2);
    const maxC = round(at(daily.temperature_2m_max, index), 2);
    const code = at(daily.weather_code, index);
    return {
      date: openMeteoDateIso(time, offset, opts.timezone),
      description: null,
      weatherCode: code != null ? Number(code) : null,
      rainMm: round(at(daily.precipitation_sum, index), 2),
      precipitationProbabilityPct: probability,
      rainProbabilityPct: probability,
      et0MmDay: round(at(daily.et0_fao_evapotranspiration, index), 2),
      temperatureMinC: minC,
      temperatureMaxC: maxC,
      minTempC: minC,
      maxTempC: maxC
    };
  }).filter((day) => day.date);
  if (!hours.length && !days.length) return null;
  return { source: 'open_meteo', observedAt: new Date(observedAtMs).toISOString(), hours, days };
}

function cacheStatus(nowIso, expiresAtIso) {
  if (!expiresAtIso) return 'miss';
  return new Date(nowIso).getTime() < new Date(expiresAtIso).getTime() ? 'live' : 'stale';
}

function extractFirstMetric(row, spec) {
  for (const alias of spec.aliases || []) {
    const value = toFiniteNumber(row && row[alias]);
    if (value != null) return value;
  }
  return null;
}

function extractMetrics(row) {
  const metrics = {};
  for (const spec of LOCAL_METRICS.concat(DEVICE_ONLY_METRICS)) {
    const value = extractFirstMetric(row, spec);
    if (value != null) {
      metrics[spec.key] = round(value, spec.decimals);
    }
  }
  return metrics;
}

function aggregateMetric(spec, deviceObservations) {
  const values = deviceObservations
    .map(device => device.metrics && device.metrics[spec.key])
    .filter(value => value != null && Number.isFinite(Number(value)))
    .map(Number);
  if (!values.length) return null;
  return {
    key: spec.key,
    label: spec.label,
    unit: spec.unit,
    mean: round(mean(values), spec.decimals),
    median: round(median(values), spec.decimals),
    min: round(minValue(values), spec.decimals),
    max: round(maxValue(values), spec.decimals),
    sampleCount: values.length
  };
}

function buildLocalEnvironment(deviceRows, nowIso) {
  const thresholdMs = 3 * 60 * 60 * 1000;
  const nowMs = new Date(nowIso).getTime();
  const deviceObservations = [];
  let observedAt = null;
  let freshSensorCount = 0;
  let staleSensorCount = 0;
  for (const row of deviceRows || []) {
    const metrics = extractMetrics(row || {});
    if (!Object.keys(metrics).length) continue;
    const deviceObservedAt = trimToNull(row.recorded_at);
    observedAt = maxInstant(observedAt, deviceObservedAt);
    if (deviceObservedAt && nowMs - new Date(deviceObservedAt).getTime() <= thresholdMs) freshSensorCount++;
    else staleSensorCount++;
    deviceObservations.push({
      deviceEui: row.deveui || null,
      name: row.name || null,
      type: row.type_id || null,
      observedAt: deviceObservedAt,
      metrics
    });
  }
  if (!deviceObservations.length) {
    return {
      available: false,
      observedAt: null,
      sensorCount: 0,
      freshSensorCount: 0,
      staleSensorCount: 0,
      metrics: [],
      devices: []
    };
  }
  const metrics = LOCAL_METRICS
    .map(spec => aggregateMetric(spec, deviceObservations))
    .filter(Boolean);
  return {
    available: true,
    observedAt,
    sensorCount: deviceObservations.length,
    freshSensorCount,
    staleSensorCount,
    metrics,
    devices: deviceObservations
  };
}

function resolveLocation(zone) {
  const zoneLat = toFiniteNumber(zone && zone.latitude);
  const zoneLon = toFiniteNumber(zone && zone.longitude);
  if (zoneLat != null && zoneLon != null) {
    return { latitude: zoneLat, longitude: zoneLon, timezone: normalizeTimezone(zone.timezone), source: 'zone' };
  }
  const gatewayLat = toFiniteNumber(zone && zone.gateway_latitude);
  const gatewayLon = toFiniteNumber(zone && zone.gateway_longitude);
  if (gatewayLat != null && gatewayLon != null) {
    return { latitude: gatewayLat, longitude: gatewayLon, timezone: normalizeTimezone(zone.timezone), source: 'gateway' };
  }
  return { latitude: null, longitude: null, timezone: normalizeTimezone(zone && zone.timezone), source: 'unavailable' };
}

function normalizeCloudServerUrl(value) {
  const trimmed = trimToNull(value);
  return trimmed ? trimmed.replace(/\/$/, '') : null;
}

function normalizeSchedulingMode(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === 'server_preferred'
    ? 'server_preferred'
    : 'local';
}

function normalizeDisplayMode(value) {
  const normalized = trimToNull(value);
  if (!normalized) return null;
  const known = ['shared_server', 'shared_server_stale', 'local_fallback', 'unlinked_local', 'cloud_local'];
  return known.includes(normalized) ? normalized : normalized;
}

function absoluteDelta(left, right, decimals) {
  const leftNumber = toFiniteNumber(left);
  const rightNumber = toFiniteNumber(right);
  if (leftNumber == null || rightNumber == null) return null;
  return round(Math.abs(leftNumber - rightNumber), decimals == null ? 2 : decimals);
}

function isIrrigationActionConflict(localAction, serverAction) {
  const left = trimToNull(localAction);
  const right = trimToNull(serverAction);
  if (!left || !right || left === right) return false;
  const irrigateLike = new Set(['irrigate_today', 'increase_10', 'increase_20', 'emergency_irrigate', 'maintain', 'decrease_10', 'decrease_20']);
  const suppressLike = new Set(['delay_irrigation', 'monitor_today', 'maintain_rain_suppression', 'maintain_recovery_hold']);
  return (irrigateLike.has(left) && suppressLike.has(right)) || (suppressLike.has(left) && irrigateLike.has(right));
}

function buildDisplayStatus(mode, schedulingMode, sourceLabel, sharedGeneratedAt, sharedObservedAt, lastReceivedAt, fallbackReason) {
  return {
    mode,
    schedulingMode,
    sourceLabel,
    sharedGeneratedAt: trimToNull(sharedGeneratedAt),
    sharedObservedAt: trimToNull(sharedObservedAt),
    lastReceivedAt: trimToNull(lastReceivedAt),
    fallbackReason: trimToNull(fallbackReason)
  };
}

function computeRecommendationDrift(zone, localWater, sharedWater, schedulingMode) {
  if (!sharedWater || !localWater) return null;
  const localActionCode = trimToNull(localWater && localWater.action && localWater.action.code);
  const serverActionCode = trimToNull(sharedWater && sharedWater.action && sharedWater.action.code);
  const waterNeededDeltaMm = absoluteDelta(localWater && localWater.waterNeededTodayMm, sharedWater && sharedWater.waterNeededTodayMm, 2);
  const next24hRainDeltaMm = absoluteDelta(localWater && localWater.next24hRainMm, sharedWater && sharedWater.next24hRainMm, 2);
  const balanceDeltaMm = absoluteDelta(localWater && localWater.balanceTodayMm, sharedWater && sharedWater.balanceTodayMm, 2);
  const actionMismatch = !!localActionCode && !!serverActionCode && localActionCode !== serverActionCode;
  const severeConflict = isIrrigationActionConflict(localActionCode, serverActionCode);
  const exceedsThreshold =
    (waterNeededDeltaMm != null && waterNeededDeltaMm >= 2) ||
    (next24hRainDeltaMm != null && next24hRainDeltaMm >= 2) ||
    (balanceDeltaMm != null && balanceDeltaMm >= 2);
  if (!actionMismatch && !exceedsThreshold) return null;
  const reasonParts = [];
  if (actionMismatch) {
    reasonParts.push(
      severeConflict
        ? 'Local and OSI Server recommendations disagree on whether to irrigate.'
        : 'Local and OSI Server recommendations differ.'
    );
  }
  if (waterNeededDeltaMm != null && waterNeededDeltaMm >= 2) {
    reasonParts.push('Estimated water need differs by ' + waterNeededDeltaMm.toFixed(1) + ' mm.');
  }
  if (next24hRainDeltaMm != null && next24hRainDeltaMm >= 2) {
    reasonParts.push('Forecast rain differs by ' + next24hRainDeltaMm.toFixed(1) + ' mm.');
  }
  if (balanceDeltaMm != null && balanceDeltaMm >= 2) {
    reasonParts.push('Water balance differs by ' + balanceDeltaMm.toFixed(1) + ' mm.');
  }
  return {
    active: true,
    severity: severeConflict ? 'high' : 'medium',
    reason: reasonParts.join(' '),
    localActionCode,
    serverActionCode,
    waterNeededDeltaMm,
    next24hRainDeltaMm,
    balanceDeltaMm,
    canSwitchScheduling: String(zone && zone.schedule_trigger_metric || '').toUpperCase() === 'DENDRO' && schedulingMode !== 'server_preferred'
  };
}

function bundleAgeMinutes(lastReceivedAt, nowIso) {
  const receivedAt = trimToNull(lastReceivedAt);
  if (!receivedAt) return Number.POSITIVE_INFINITY;
  const diffMs = new Date(nowIso).getTime() - new Date(receivedAt).getTime();
  return Number.isFinite(diffMs) ? diffMs / 60000 : Number.POSITIVE_INFINITY;
}

function normalizePrecipitationProbability(value) {
  const numeric = toFiniteNumber(value);
  if (numeric == null) return null;
  return numeric <= 1 ? numeric * 100 : numeric;
}

function parseOpenAgriForecast(entries, opts = {}) {
  const observedAtMs = opts.observedAtMs != null ? opts.observedAtMs : Date.now();
  if (!Array.isArray(entries) || !entries.length) return null;
  const buckets = {};
  for (const entry of entries) {
    const timestamp = toIsoTime(entry && entry.timestamp);
    const measurementType = trimToNull(entry && entry.measurement_type);
    const value = toFiniteNumber(entry && entry.value);
    if (!timestamp || !measurementType || value == null) continue;
    if (!buckets[timestamp]) {
      buckets[timestamp] = { time: timestamp };
    }
    if (measurementType === 'ambient_temperature') buckets[timestamp].airTemperatureC = round(value, 2);
    else if (measurementType === 'ambient_humidity') buckets[timestamp].relativeHumidityPct = round(value, 1);
    else if (measurementType === 'wind_speed') buckets[timestamp].windSpeedMps = round(value, 2);
    else if (measurementType === 'wind_direction') buckets[timestamp].windDirectionDeg = round(value, 1);
    else if (measurementType === 'rainfall_3h') buckets[timestamp].rainMm = round(value, 2);
    else if (measurementType === 'precipitation') buckets[timestamp].precipitationProbabilityPct = round(normalizePrecipitationProbability(value), 1);
  }
  const hours = Object.keys(buckets).sort().map(key => ({
    time: key,
    airTemperatureC: buckets[key].airTemperatureC ?? null,
    relativeHumidityPct: buckets[key].relativeHumidityPct ?? null,
    rainMm: buckets[key].rainMm ?? null,
    precipitationProbabilityPct: buckets[key].precipitationProbabilityPct ?? null,
    windSpeedMps: buckets[key].windSpeedMps ?? null,
    windDirectionDeg: buckets[key].windDirectionDeg ?? null
  }));
  return hours.length ? { source: 'openagri', observedAt: new Date(observedAtMs).toISOString(), hours, days: [] } : null;
}

function mergeForecasts(primary, supplement, opts = {}) {
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  if (!primary && !supplement) return null;
  if (!primary) return supplement;
  if (!supplement) return primary;
  const daysByDate = {};
  for (const day of supplement.days || []) {
    if (day && day.date) daysByDate[day.date] = day;
  }
  const mergedDays = [];
  for (const day of primary.days || []) {
    const extra = day && day.date ? daysByDate[day.date] : null;
    if (day && day.date) delete daysByDate[day.date];
    mergedDays.push({
      date: day.date,
      rainMm: day.rainMm != null ? day.rainMm : extra ? extra.rainMm : null,
      precipitationProbabilityPct: day.precipitationProbabilityPct != null ? day.precipitationProbabilityPct : extra ? extra.precipitationProbabilityPct : null,
      et0MmDay: day.et0MmDay != null ? day.et0MmDay : extra ? extra.et0MmDay : null,
      temperatureMinC: day.temperatureMinC != null ? day.temperatureMinC : extra ? extra.temperatureMinC : null,
      temperatureMaxC: day.temperatureMaxC != null ? day.temperatureMaxC : extra ? extra.temperatureMaxC : null
    });
  }
  for (const date of Object.keys(daysByDate).sort()) {
    mergedDays.push(daysByDate[date]);
  }
  return {
    source: primary.source || supplement.source || 'open_meteo',
    observedAt: primary.observedAt || supplement.observedAt || new Date(nowMs).toISOString(),
    hours: Array.isArray(primary.hours) && primary.hours.length ? primary.hours : (supplement.hours || []),
    days: mergedDays
  };
}

function findMetric(local, key) {
  return (local && Array.isArray(local.metrics) ? local.metrics : []).find(metric => metric && metric.key === key) || null;
}

function estimateStepHours(hours) {
  const diffs = [];
  for (let i = 1; i < (hours || []).length; i++) {
    const prev = hours[i - 1] && hours[i - 1].time ? new Date(hours[i - 1].time).getTime() : null;
    const next = hours[i] && hours[i].time ? new Date(hours[i].time).getTime() : null;
    if (prev == null || next == null || next <= prev) continue;
    const hoursDiff = (next - prev) / 3600000;
    if (hoursDiff > 0 && hoursDiff <= 6) diffs.push(hoursDiff);
  }
  return median(diffs) || 1;
}

/**
 * Forecast rain over [now, now + horizon) and how much of the horizon it
 * covers. Only forecast steps with a rain value count; each covers the
 * provider's step length (one hour for Open-Meteo, three for OpenAgri). No
 * covered step means the total is unknown (null), never 0 mm; a partly
 * covered horizon keeps the sum of what is known, with its coverage.
 */
function sumRain(hours, nowMs, horizonHours) {
  const endMs = nowMs + horizonHours * 3600000;
  const list = Array.isArray(hours) ? hours : [];
  const seen = new Set();
  let total = 0;
  for (const hour of list) {
    const timestamp = hour && hour.time ? new Date(hour.time).getTime() : NaN;
    const rainMm = toFiniteNumber(hour && hour.rainMm);
    if (!Number.isFinite(timestamp) || rainMm == null || timestamp < nowMs || timestamp >= endMs || seen.has(timestamp)) continue;
    seen.add(timestamp);
    total += rainMm;
  }
  const coveredHours = seen.size ? Math.min(horizonHours, round(seen.size * estimateStepHours(list), 2)) : 0;
  return { totalMm: seen.size ? round(total, 2) : null, coveredHours, expectedHours: horizonHours };
}

function buildForecastSection(forecastData, cacheState, expiresAt, crop, nowIso) {
  if (!forecastData) {
    return {
      available: false,
      source: 'unavailable',
      cacheStatus: cacheState,
      observedAt: null,
      expiresAt: expiresAt || null,
      rainFocus: null
    };
  }
  const nowMs = new Date(nowIso).getTime();
  const hours = Array.isArray(forecastData.hours) ? forecastData.hours.filter(hour => hour && hour.time) : [];
  const days = Array.isArray(forecastData.days) ? forecastData.days.filter(day => day && day.date) : [];
  const next24Hours = hours.filter(hour => {
    const timestamp = new Date(hour.time).getTime();
    return Number.isFinite(timestamp) && timestamp >= nowMs && timestamp < nowMs + 24 * 3600000;
  }).slice(0, 24);
  const maxRainHour = hours
    .filter(hour => toFiniteNumber(hour && hour.rainMm) != null)
    .sort((left, right) => Number(right.rainMm || 0) - Number(left.rainMm || 0))[0] || null;
  const nextRainHour = hours.find(hour => {
    const timestamp = hour && hour.time ? new Date(hour.time).getTime() : NaN;
    return Number.isFinite(timestamp) && timestamp >= nowMs && Number(hour.rainMm || 0) > 0.05;
  }) || null;
  const stepHours = estimateStepHours(hours);
  const next24h = sumRain(hours, nowMs, 24);
  // Each forecast day takes its own place on the FAO-56 curve (contract v2 A5).
  const kcOn = (date) => resolveKc({ ...(crop || {}), date }).kc;
  return {
    available: true,
    source: forecastData.source || 'open_meteo',
    cacheStatus: cacheState,
    observedAt: forecastData.observedAt || nowIso,
    expiresAt: expiresAt || null,
    rainFocus: {
      totalNext24hMm: next24h.totalMm,
      totalNext72hMm: sumRain(hours, nowMs, 72).totalMm,
      next24hCoverage: { coveredHours: next24h.coveredHours, expectedHours: next24h.expectedHours },
      maxHourlyRainMm: maxRainHour ? round(maxRainHour.rainMm, 2) : null,
      maxHourlyRainAt: maxRainHour ? maxRainHour.time : null,
      nextRainEta: nextRainHour ? nextRainHour.time : null,
      rainHoursNext24h: Math.round(next24Hours.filter(hour => Number(hour.rainMm || 0) > 0.05).length * stepHours),
      daily: days.slice(0, 5).map(day => ({
        date: day.date,
        description: day.description ?? null,
        weatherCode: day.weatherCode ?? null,
        maxTempC: day.maxTempC ?? day.temperatureMaxC ?? null,
        minTempC: day.minTempC ?? day.temperatureMinC ?? null,
        rainMm: day.rainMm ?? null,
        rainProbabilityPct: day.rainProbabilityPct ?? day.precipitationProbabilityPct ?? null,
        et0MmDay: day.et0MmDay ?? null,
        cropCoefficientKc: round(kcOn(day.date), 2),
        etcMmDay: day.et0MmDay != null ? round(day.et0MmDay * kcOn(day.date), 2) : null
      })),
      hourly: next24Hours.map(hour => ({
        time: hour.time,
        tempC: hour.tempC ?? hour.airTemperatureC ?? null,
        rainMm: hour.rainMm ?? null,
        rainProbabilityPct: hour.rainProbabilityPct ?? hour.precipitationProbabilityPct ?? null
      }))
    }
  };
}

function buildAgronomic(local, online, forecast, { cropType = null, phenologicalStage = null, stageStartedOn = null, todayIso = null, forecastFetchedAt = null, timezone = 'UTC' } = {}) {
  const localTemperature = findMetric(local, 'air_temperature_c');
  const localHumidity = findMetric(local, 'relative_humidity_pct');
  const usingLocal = localTemperature && localHumidity && localTemperature.median != null && localHumidity.median != null;
  const effectiveTemperature = usingLocal ? localTemperature.median : online && online.current ? online.current.airTemperatureC : null;
  const effectiveHumidity = usingLocal ? localHumidity.median : online && online.current ? online.current.relativeHumidityPct : null;
  // Today's ET0 is the forecast day dated today, and only from a forecast that
  // is live or was fetched today in the zone's timezone: offline across
  // midnight, today is unknown, never yesterday's value.
  const fresh = !!forecast && (forecast.cacheStatus === 'live' || (forecastFetchedAt != null && localDateIso(forecastFetchedAt, timezone) === todayIso));
  const days = fresh && forecast.rainFocus && Array.isArray(forecast.rainFocus.daily) ? forecast.rainFocus.daily : [];
  const todayRow = todayIso ? days.find((d) => d && d.date === todayIso) : null;
  const et0 = todayRow ? toFiniteNumber(todayRow.et0MmDay) : null;
  const resolved = resolveKc({ cropType, phenologicalStage, stageStartedOn, date: todayIso });
  const kc = resolved.kc;
  return {
    preferredSource: usingLocal ? 'local' : (online && online.current ? online.source : 'unavailable'),
    current: {
      thermodynamicSource: effectiveTemperature != null && effectiveHumidity != null ? (usingLocal ? 'local' : (online ? online.source : 'unavailable')) : 'unavailable',
      evapotranspirationSource: et0 != null ? 'open_meteo' : 'unavailable',
      cropCoefficientSource: kc != null ? resolved.kcSource : 'unavailable',
      cropId: resolved.cropId,
      stage: resolved.stage,
      stageOverrun: resolved.stageOverrun,
      airTemperatureC: effectiveTemperature != null ? round(effectiveTemperature, 2) : null,
      relativeHumidityPct: effectiveHumidity != null ? round(effectiveHumidity, 1) : null,
      vpdKpa: round(computeVPD(effectiveTemperature, effectiveHumidity), 3),
      dewPointC: round(computeDewPoint(effectiveTemperature, effectiveHumidity), 2),
      heatIndexC: round(computeHeatIndexC(effectiveTemperature, effectiveHumidity), 2),
      thi: round(computeTHI(effectiveTemperature, effectiveHumidity), 2),
      referenceEt0MmDay: et0 != null ? round(et0, 2) : null,
      cropCoefficientKc: kc != null ? round(kc, 2) : null,
      etcMmDay: et0 != null && kc != null ? round(et0 * kc, 2) : null
    }
  };
}

function localDateIso(value, timezone, nowMs) {
  const date = value ? new Date(value) : new Date(nowMs != null ? nowMs : Date.now());
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const byType = {};
  for (const part of parts) {
    if (part.type !== 'literal') byType[part.type] = part.value;
  }
  if (!byType.year || !byType.month || !byType.day) return null;
  return byType.year + '-' + byType.month + '-' + byType.day;
}

function addUtcDays(dateIso, days) {
  const base = trimToNull(dateIso);
  if (!base) return null;
  const date = new Date(base + 'T00:00:00.000Z');
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

/**
 * The `rain_source` labels the edge's rain writers stamp on a
 * zone_daily_environment row (LoRain, S2120, LSN50 MOD9 gauge). Any other
 * label, including the column default 'none' that a flow-only row keeps, is
 * not rain evidence.
 */
const GAUGE_RAIN_SOURCES = ['aquascope_lorain', 'sensecap_s2120', 'local_gauge'];

/**
 * A zone_daily_environment row's rain in mm, or null when the row is no
 * evidence (unknown, never zero). A non-zero amount from a gauge source, or
 * from a legacy row without a source, is a measurement; an exact zero counts
 * only while a rain-measuring device is configured for the zone. Same rule as
 * the cloud's ZoneRainEvidence.trustedRainMm, so a linked gateway and the
 * cloud read one row the same way. A measured 0 from a gauge is observed.
 */
function resolveRainTodayMm(row, rainGaugePresent) {
  if (!row) return null;
  const mm = toFiniteNumber(row.rainfall_mm);
  if (mm == null) return null;
  if (row.rain_source != null && GAUGE_RAIN_SOURCES.indexOf(String(row.rain_source).trim().toLowerCase()) < 0) return null;
  if (mm === 0 && !rainGaugePresent) return null;
  return round(mm, 2);
}

function toEffectiveIrrigationMm(irrigationLiters, areaM2, irrigationEfficiencyPct) {
  const liters = toFiniteNumber(irrigationLiters);
  const area = toFiniteNumber(areaM2);
  const efficiency = toFiniteNumber(irrigationEfficiencyPct);
  if (liters == null || area == null || efficiency == null || area <= 0 || efficiency <= 0) return null;
  return round(liters * (efficiency / 100) / area, 2);
}

/**
 * The Water tab's seven day rows, oldest first, ending today. The node queries
 * the rows; this turns them into the day shape. A day without a rain row is
 * null, never 0 (the cloud's F115 rule). Past days carry the stored
 * zone_daily_agronomy snapshot ('calculated'); today carries the forecast
 * demand, with ET0, Kc, crop and stage from the agronomic block
 * (`todayAgronomic`, i.e. `agronomic.current`), and `nullReason
 * 'demand_unknown'` when there is no forecast demand. A station name is the
 * devices.name of a deveui; a MeteoSwiss id has no devices row and shows as
 * itself. A day's rain follows resolveRainTodayMm; `rainGaugePresent`
 * undefined (an older caller) counts a zero as measured, as before.
 */
function buildWaterDaily({ envRows, estimatedByDate, agronomyRows, zone, todayIso, waterNeededTodayMm, kcSourceToday, todayAgronomic, stationNames, rainGaugePresent }) {
  const startIso = addUtcDays(todayIso, -6) || todayIso;
  const byDate = {};
  for (const row of envRows || []) if (row && row.date) byDate[String(row.date)] = row;
  const agronomyByDate = {};
  for (const row of agronomyRows || []) if (row && row.date) agronomyByDate[String(row.date)] = row;
  const names = stationNames || {};
  const estimated = estimatedByDate || {};
  const daily = [];
  for (let dateIso = startIso; dateIso && dateIso <= todayIso; dateIso = addUtcDays(dateIso, 1)) {
    const row = byDate[dateIso] || null;
    const rainMm = resolveRainTodayMm(row, rainGaugePresent === undefined ? true : rainGaugePresent);
    const measuredIrrigationLiters = round(row ? row.flow_liters : 0, 2) || 0;
    const estimatedIrrigationLiters = round(estimated[dateIso] || 0, 2) || 0;
    const measuredIrrigationNetMm = toEffectiveIrrigationMm(measuredIrrigationLiters, zone && zone.area_m2, zone && zone.irrigation_efficiency_pct);
    const estimatedIrrigationNetMm = toEffectiveIrrigationMm(estimatedIrrigationLiters, zone && zone.area_m2, zone && zone.irrigation_efficiency_pct);
    const day = {
      date: dateIso,
      rainMm,
      irrigationLiters: measuredIrrigationLiters,
      irrigationNetMm: measuredIrrigationNetMm,
      measuredIrrigationLiters,
      estimatedIrrigationLiters,
      measuredIrrigationNetMm,
      estimatedIrrigationNetMm,
      totalWaterMm: measuredIrrigationNetMm != null && rainMm != null ? round(rainMm + measuredIrrigationNetMm, 2) : null,
      estimatedTotalWaterMm: estimatedIrrigationNetMm != null && rainMm != null ? round(rainMm + estimatedIrrigationNetMm, 2) : null
    };
    const a = agronomyByDate[dateIso] || null;
    if (dateIso === todayIso) {
      const cur = todayAgronomic && typeof todayAgronomic === 'object' ? todayAgronomic : {};
      const todayEt0 = toFiniteNumber(cur.referenceEt0MmDay);
      const todayKc = toFiniteNumber(cur.cropCoefficientKc);
      Object.assign(day, {
        demandMm: waterNeededTodayMm != null ? round(waterNeededTodayMm, 2) : null,
        demandSource: waterNeededTodayMm != null ? 'forecast' : null,
        et0Mm: todayEt0 != null ? round(todayEt0, 2) : null, et0Source: null, et0Tier: null, et0StationId: null, et0StationName: null,
        kc: todayKc != null ? round(todayKc, 2) : null, kcSource: kcSourceToday || trimToNull(cur.cropCoefficientSource),
        cropType: trimToNull(cur.cropId), phenologicalStage: trimToNull(cur.stage),
        stageOverrun: typeof cur.stageOverrun === 'boolean' ? cur.stageOverrun : null, demandComputedBy: null,
        hoursPresent: null, expectedHours: null, nullReason: waterNeededTodayMm != null ? null : 'demand_unknown'
      });
    } else {
      const stationId = a ? a.et0_station_id || null : null;
      Object.assign(day, {
        demandMm: a && a.etc_mm != null ? a.etc_mm : null,
        demandSource: a && a.etc_mm != null ? 'calculated' : null,
        et0Mm: a ? a.et0_mm : null, et0Source: a ? a.et0_source : null, et0Tier: a ? a.et0_tier : null,
        et0StationId: stationId, et0StationName: stationId ? (names[stationId] || stationId) : null,
        kc: a ? a.kc : null, kcSource: a ? a.kc_source : null, cropType: a ? a.crop_type : null, phenologicalStage: a ? a.phenological_stage : null,
        stageOverrun: a && a.stage_overrun != null ? Number(a.stage_overrun) === 1 : null,
        // 'edge' when the gateway stored a demand for the day (spec 2026-09-27-daily-agronomy-parity B7).
        demandComputedBy: a && a.etc_mm != null ? 'edge' : null,
        hoursPresent: a ? a.hours_present : null, expectedHours: a ? a.expected_hours : null, nullReason: a ? a.null_reason : null
      });
    }
    daily.push(day);
    if (dateIso === todayIso) break;
  }
  return daily;
}

function addCounterWarning(warnings, rawStatus, label) {
  const status = trimToNull(rawStatus);
  if (!status || status.toLowerCase() === 'ok') return;
  switch (status.toLowerCase()) {
    case 'first_sample':
    case 'cumulative_baseline':
      warnings.push(label + ' is waiting for the next reading');
      break;
    case 'intensity_only':
      warnings.push(label + ' reported intensity only; the rain amount for this interval is unknown');
      break;
    case 'counter_reset':
      warnings.push(label + " restarted; today's total may be incomplete");
      break;
    case 'duplicate_timestamp':
      warnings.push(label + ' reported a duplicate reading');
      break;
    case 'out_of_order':
      warnings.push(label + ' reported an out-of-order reading');
      break;
    default:
      warnings.push(label + ' status: ' + status);
  }
}

/**
 * Device types that measure rain without the opt-in LSN50 MOD9 rain input:
 * the SenseCAP S2120's cumulative gauge and the Aqua-Scope LoRain's interval
 * tips both feed `zone_daily_environment.rainfall_mm`.
 */
const RAIN_SOURCE_TYPE_IDS = ['SENSECAP_S2120', 'AQUASCOPE_LORAIN'];

function hasRainSource(row) {
  if (!row) return false;
  if (Number(row.rain_gauge_enabled) === 1) return true;
  return RAIN_SOURCE_TYPE_IDS.indexOf(trimToNull(row.type_id)) >= 0;
}

function buildSensorHealth(deviceRows, local) {
  const warnings = [];
  if ((local && local.staleSensorCount) > 0) {
    warnings.push(local.staleSensorCount === 1 ? '1 sensor is stale' : local.staleSensorCount + ' sensors are stale');
  }
  for (const row of deviceRows || []) {
    addCounterWarning(warnings, row && row.rain_delta_status, 'Rain gauge');
    addCounterWarning(warnings, row && row.flow_delta_status, 'Flow meter');
  }
  return {
    sensorCount: local && Number.isFinite(local.sensorCount) ? local.sensorCount : 0,
    freshSensorCount: local && Number.isFinite(local.freshSensorCount) ? local.freshSensorCount : 0,
    staleSensorCount: local && Number.isFinite(local.staleSensorCount) ? local.staleSensorCount : 0,
    rainGaugePresent: (deviceRows || []).some(hasRainSource),
    flowMeterPresent: (deviceRows || []).some(row => Number(row && row.flow_meter_enabled) === 1),
    warnings: Array.from(new Set(warnings))
  };
}

/**
 * The zone's water-balance verdict, as an action code plus a reason code.
 *
 * Both inputs used to be coerced to 0 (`?? 0`), so a zone with no area and no
 * irrigation efficiency — every zone until someone fills in the configuration
 * modal — had `balanceTodayMm === null` read as a balanced 0 and was told to
 * delay irrigation unconditionally. That is the one recommendation that costs
 * a crop when it is wrong, and it was emitted precisely where the edge knew
 * the least. An input the branch actually depends on now has to be known;
 * otherwise the action is absent and the caller renders an
 * insufficient-data state.
 *
 * The reason travels as a code rather than as an English sentence: the GUI
 * serves seven languages and cannot translate prose the edge invented.
 *
 * `rainTodayKnown === false` with a known irrigation (`irrigationNetMm`) and
 * demand hands the verdict to resolveRainUnknownWaterAction under
 * RAIN_UNKNOWN_POLICY. A caller that omits it keeps the old codes.
 */
function resolveWaterAction(todayIso, recommendationRow, balanceTodayMm, next24hRainMm, waterNeededTodayMm, rainTodayKnown, irrigationNetMm) {
  if (recommendationRow) {
    return {
      code: trimToNull(recommendationRow.irrigation_action),
      source: 'dendro',
      reasonCode: null,
      reasoning: trimToNull(recommendationRow.action_reasoning),
      recommendationDate: trimToNull(recommendationRow.date) || todayIso
    };
  }
  const insufficient = (reasonCode) => ({
    code: null,
    source: 'insufficient_data',
    reasonCode,
    recommendationDate: todayIso
  });
  const heuristic = (code, reasonCode) => ({
    code,
    source: 'heuristic',
    reasonCode,
    recommendationDate: todayIso
  });

  const balance = toFiniteNumber(balanceTodayMm);
  const irrigation = toFiniteNumber(irrigationNetMm);
  const demand = toFiniteNumber(waterNeededTodayMm);
  if (balance == null && rainTodayKnown === false && irrigation != null && demand != null) {
    return resolveRainUnknownWaterAction(RAIN_UNKNOWN_POLICY, todayIso, null, round(irrigation - demand, 2), next24hRainMm);
  }
  // No demand for today is the cloud's demand_unknown; balance_unknown stays
  // for the missing zone area or efficiency ("set up the zone"). A caller
  // that does not pass the demand keeps the old code.
  if (balance == null && waterNeededTodayMm !== undefined && toFiniteNumber(waterNeededTodayMm) == null) return insufficient('demand_unknown');
  if (balance == null) return insufficient('balance_unknown');
  // A non-negative balance settles the verdict on its own; the forecast only
  // matters when today's supply falls short.
  if (balance >= 0) return heuristic('delay_irrigation', 'supply_covers_demand');

  const shortfallMm = -balance;
  const forecastRain = toFiniteNumber(next24hRainMm);
  if (forecastRain == null) return insufficient('forecast_unknown');
  if (forecastRain >= shortfallMm) return heuristic('delay_irrigation', 'forecast_rain_covers_demand');
  if (balance <= -1) return heuristic('irrigate_today', 'demand_exceeds_supply');
  return heuristic('monitor_today', 'balance_neutral');
}

/**
 * What a rain-dependent water verdict does while today's rain is unknown
 * (owner decision D2, 2026-10-09): 'warn' computes it on zero rain and flags
 * it rain_unknown; 'withhold' answers insufficient_data / rain_unknown. The
 * cloud has the same switch under the same name (ZoneRainEvidence in the
 * backend, engine.py in the prediction service): flip all three together, so
 * a linked and an unlinked gateway answer alike. Unknown rain never starts
 * dendrometer rain suppression under either value.
 */
const RAIN_UNKNOWN_POLICY = 'warn';

/**
 * The water verdict while today's rain is unknown and irrigation and demand
 * are known. `supplyWithoutRainMm` is irrigation minus demand, the balance at
 * zero rain and so a lower bound on the real one. Under 'warn' the usual
 * branch order runs on that bound and the verdict carries reasonCode
 * rain_unknown in place of its own; when the verdict still needs a missing
 * forecast, or under 'withhold', the answer is insufficient_data /
 * rain_unknown. A dendrometer verdict passes unchanged: it does not depend on
 * rain. Mirrors the cloud's ZoneEnvironmentService.resolveRainUnknownWaterAction.
 */
function resolveRainUnknownWaterAction(policy, todayIso, recommendationRow, supplyWithoutRainMm, next24hRainMm) {
  if (recommendationRow) return resolveWaterAction(todayIso, recommendationRow, null, next24hRainMm);
  const insufficient = { code: null, source: 'insufficient_data', reasonCode: 'rain_unknown', recommendationDate: todayIso };
  if (policy !== 'warn') return insufficient;
  const verdict = resolveWaterAction(todayIso, null, supplyWithoutRainMm, next24hRainMm);
  if (verdict.code == null) return insufficient;
  return { ...verdict, reasonCode: 'rain_unknown' };
}

const DEMAND_FIELDS = ['demandMm', 'demandSource', 'demandComputedBy', 'et0Mm', 'et0Source', 'et0Tier', 'et0StationId', 'et0StationName', 'kc', 'kcSource', 'cropType', 'phenologicalStage', 'stageOverrun', 'hoursPresent', 'expectedHours', 'nullReason'];
const SPLIT_FIELDS = ['irrigationLiters', 'irrigationNetMm', 'measuredIrrigationLiters', 'estimatedIrrigationLiters', 'measuredIrrigationNetMm', 'estimatedIrrigationNetMm', 'estimatedTotalWaterMm'];

function pick(row, fields) {
  const out = {};
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

function mergeDailyIrrigationSplit(sharedDaily, localDaily, todayIso) {
  const localRows = Array.isArray(localDaily) ? localDaily : [];
  if (!Array.isArray(sharedDaily)) return localRows;
  const localByDate = {};
  for (const row of localRows) if (row && row.date) localByDate[String(row.date)] = row;
  const merged = sharedDaily.map((row) => {
    if (!row || !row.date) return row;
    const local = localByDate[String(row.date)];
    if (!local) return row;
    // The gateway's demand replaces the cloud's for every day the gateway
    // computed, and today; a past day the gateway has no value for keeps the
    // cloud's own row (demandComputedBy 'cloud'). A cloud that sends no
    // demandComputedBy predates sub-project 4 and has no daily record: the
    // gateway's fields fill the day as before.
    const gatewayDay = local.demandComputedBy === 'edge' || String(row.date) === todayIso || row.demandComputedBy === undefined;
    return { ...row, ...pick(local, SPLIT_FIELDS), ...(gatewayDay ? pick(local, DEMAND_FIELDS) : {}) };
  });
  // A bundle that ends before today (stale across midnight) gets the local today row.
  if (todayIso && !merged.some((row) => row && row.date === todayIso) && localByDate[todayIso]) merged.push(localByDate[todayIso]);
  return merged.slice(-7);
}

function overlayLocalWaterIrrigationSplit(sharedWater, localWater, todayIso) {
  if (!sharedWater || typeof sharedWater !== 'object') return localWater;
  if (!localWater || typeof localWater !== 'object') return sharedWater;
  const sharedDaily = Array.isArray(sharedWater.daily) ? sharedWater.daily : [];
  const last = sharedDaily.length ? sharedDaily[sharedDaily.length - 1] : null;
  const bundleCurrent = !!last && last.date === todayIso;
  const sharedToday = toFiniteNumber(sharedWater.waterNeededTodayMm);
  // A current bundle's demand is the cloud's: the gateway's own ET0 and Kc
  // for today would describe a number it did not compute, so they are dropped.
  const daily = mergeDailyIrrigationSplit(sharedWater.daily, localWater.daily, todayIso).map((row) => {
    if (!row || row.date !== todayIso) return row;
    return bundleCurrent
      ? { ...row, demandMm: sharedToday, demandSource: sharedToday != null ? 'forecast' : null, kcSource: 'server', et0Mm: null, kc: null, nullReason: sharedToday != null ? null : 'demand_unknown' }
      : { ...row, kcSource: 'local' };
  });
  // A bundle that ends before today describes yesterday: every "today" field
  // of the tile comes from the gateway, so the tile shows one day.
  const today = bundleCurrent || !todayIso ? {} : {
    rainTodayMm: localWater.rainTodayMm,
    rainTodayStatus: localWater.rainTodayStatus,
    rainSource: localWater.rainSource != null ? localWater.rainSource : null,
    balanceTodayMm: localWater.balanceTodayMm,
    next24hRainMm: localWater.next24hRainMm,
    action: localWater.action
  };
  return {
    ...sharedWater,
    ...today,
    available: sharedWater.available || localWater.available,
    irrigationTodayLiters: localWater.irrigationTodayLiters,
    irrigationTodayNetMm: localWater.irrigationTodayNetMm,
    irrigationTodayMeasuredLiters: localWater.irrigationTodayMeasuredLiters,
    irrigationTodayEstimatedLiters: localWater.irrigationTodayEstimatedLiters,
    measuredIrrigationNetMm: localWater.measuredIrrigationNetMm,
    estimatedIrrigationNetMm: localWater.estimatedIrrigationNetMm,
    waterNeededTodayMm: bundleCurrent ? sharedWater.waterNeededTodayMm : localWater.waterNeededTodayMm,
    todayDate: todayIso,
    daily
  };
}

module.exports = {
  trimToNull,
  normalizeTimezone,
  toFiniteNumber,
  round,
  mean,
  median,
  minValue,
  maxValue,
  computeVPD,
  computeDewPoint,
  computeHeatIndexC,
  computeTHI,
  maxInstant,
  safeJsonParse,
  toIsoTime,
  openMeteoInstantIso,
  openMeteoDateIso,
  parseOpenMeteoForecast,
  cacheStatus,
  extractFirstMetric,
  extractMetrics,
  aggregateMetric,
  buildLocalEnvironment,
  resolveLocation,
  normalizeCloudServerUrl,
  normalizeSchedulingMode,
  normalizeDisplayMode,
  absoluteDelta,
  isIrrigationActionConflict,
  buildDisplayStatus,
  computeRecommendationDrift,
  bundleAgeMinutes,
  normalizePrecipitationProbability,
  parseOpenAgriForecast,
  mergeForecasts,
  findMetric,
  estimateStepHours,
  sumRain,
  buildForecastSection,
  buildAgronomic,
  localDateIso,
  addUtcDays,
  GAUGE_RAIN_SOURCES,
  resolveRainTodayMm,
  toEffectiveIrrigationMm,
  buildWaterDaily,
  buildSensorHealth,
  resolveWaterAction,
  RAIN_UNKNOWN_POLICY,
  resolveRainUnknownWaterAction,
  mergeDailyIrrigationSplit,
  overlayLocalWaterIrrigationSplit,
};
