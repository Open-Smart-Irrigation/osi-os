'use strict';

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
const KC_BY_STAGE = {
  dormancy: 0.25,
  bud_break: 0.45,
  cell_division: 0.70,
  cell_expansion: 0.90,
  fruit_maturation: 0.85,
  post_harvest: 0.60,
  default: 0.75
};

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

function deriveCropCoefficient(stage) {
  const normalized = trimToNull(stage);
  if (!normalized) return KC_BY_STAGE.default;
  return KC_BY_STAGE[String(normalized).toLowerCase()] || KC_BY_STAGE.default;
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

function sumRain(hours, nowMs, horizonHours) {
  const endMs = nowMs + horizonHours * 3600000;
  return round((hours || []).reduce((total, hour) => {
    const timestamp = hour && hour.time ? new Date(hour.time).getTime() : NaN;
    const rainMm = toFiniteNumber(hour && hour.rainMm);
    if (!Number.isFinite(timestamp) || rainMm == null || timestamp < nowMs || timestamp >= endMs) return total;
    return total + rainMm;
  }, 0), 2) || 0;
}

function buildForecastSection(forecastData, cacheState, expiresAt, stage, nowIso) {
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
  const kc = deriveCropCoefficient(stage);
  return {
    available: true,
    source: forecastData.source || 'open_meteo',
    cacheStatus: cacheState,
    observedAt: forecastData.observedAt || nowIso,
    expiresAt: expiresAt || null,
    rainFocus: {
      totalNext24hMm: sumRain(hours, nowMs, 24),
      totalNext72hMm: sumRain(hours, nowMs, 72),
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
        cropCoefficientKc: round(kc, 2),
        etcMmDay: day.et0MmDay != null ? round(day.et0MmDay * kc, 2) : null
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

function buildAgronomic(local, online, forecast, stage) {
  const localTemperature = findMetric(local, 'air_temperature_c');
  const localHumidity = findMetric(local, 'relative_humidity_pct');
  const usingLocal = localTemperature && localHumidity && localTemperature.median != null && localHumidity.median != null;
  const effectiveTemperature = usingLocal ? localTemperature.median : online && online.current ? online.current.airTemperatureC : null;
  const effectiveHumidity = usingLocal ? localHumidity.median : online && online.current ? online.current.relativeHumidityPct : null;
  const et0 = forecast && forecast.rainFocus && Array.isArray(forecast.rainFocus.daily) && forecast.rainFocus.daily.length
    ? toFiniteNumber(forecast.rainFocus.daily[0].et0MmDay)
    : null;
  const kc = deriveCropCoefficient(stage);
  return {
    preferredSource: usingLocal ? 'local' : (online && online.current ? online.source : 'unavailable'),
    current: {
      thermodynamicSource: effectiveTemperature != null && effectiveHumidity != null ? (usingLocal ? 'local' : (online ? online.source : 'unavailable')) : 'unavailable',
      evapotranspirationSource: et0 != null ? 'open_meteo' : 'unavailable',
      cropCoefficientSource: kc != null ? 'heuristic_phenology' : 'unavailable',
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

function toEffectiveIrrigationMm(irrigationLiters, areaM2, irrigationEfficiencyPct) {
  const liters = toFiniteNumber(irrigationLiters);
  const area = toFiniteNumber(areaM2);
  const efficiency = toFiniteNumber(irrigationEfficiencyPct);
  if (liters == null || area == null || efficiency == null || area <= 0 || efficiency <= 0) return null;
  return round(liters * (efficiency / 100) / area, 2);
}

function addCounterWarning(warnings, rawStatus, label) {
  const status = trimToNull(rawStatus);
  if (!status || status.toLowerCase() === 'ok') return;
  switch (status.toLowerCase()) {
    case 'first_sample':
      warnings.push(label + ' is waiting for the next reading');
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
    rainGaugePresent: (deviceRows || []).some(row => Number(row && row.rain_gauge_enabled) === 1),
    flowMeterPresent: (deviceRows || []).some(row => Number(row && row.flow_meter_enabled) === 1),
    warnings: Array.from(new Set(warnings))
  };
}

function resolveWaterAction(todayIso, recommendationRow, balanceTodayMm, next24hRainMm) {
  if (recommendationRow) {
    return {
      code: trimToNull(recommendationRow.irrigation_action),
      source: 'dendro',
      reasoning: trimToNull(recommendationRow.action_reasoning),
      recommendationDate: trimToNull(recommendationRow.date) || todayIso
    };
  }
  const effectiveBalance = toFiniteNumber(balanceTodayMm) ?? 0;
  const forecastRain = toFiniteNumber(next24hRainMm) ?? 0;
  if (effectiveBalance >= 1 || forecastRain >= Math.abs(Math.min(effectiveBalance, 0))) {
    return {
      code: 'delay_irrigation',
      source: 'heuristic',
      reasoning: "Available rain and effective irrigation cover today's estimated demand.",
      recommendationDate: todayIso
    };
  }
  if (effectiveBalance <= -1) {
    return {
      code: 'irrigate_today',
      source: 'heuristic',
      reasoning: 'Estimated demand exceeds effective rain and irrigation for today.',
      recommendationDate: todayIso
    };
  }
  return {
    code: 'monitor_today',
    source: 'heuristic',
    reasoning: 'Water balance is close to neutral; monitor soil and tree stress before irrigating.',
    recommendationDate: todayIso
  };
}

function mergeDailyIrrigationSplit(sharedDaily, localDaily) {
  const localRows = Array.isArray(localDaily) ? localDaily : [];
  const localByDate = {};
  for (const row of localRows) {
    if (row && row.date) localByDate[String(row.date)] = row;
  }
  if (!Array.isArray(sharedDaily)) return localRows;
  return sharedDaily.map((row) => {
    if (!row || !row.date) return row;
    const local = localByDate[String(row.date)];
    if (!local) return row;
    return {
      ...row,
      irrigationLiters: local.irrigationLiters,
      irrigationNetMm: local.irrigationNetMm,
      measuredIrrigationLiters: local.measuredIrrigationLiters,
      estimatedIrrigationLiters: local.estimatedIrrigationLiters,
      measuredIrrigationNetMm: local.measuredIrrigationNetMm,
      estimatedIrrigationNetMm: local.estimatedIrrigationNetMm,
      estimatedTotalWaterMm: local.estimatedTotalWaterMm
    };
  });
}

function overlayLocalWaterIrrigationSplit(sharedWater, localWater) {
  if (!sharedWater || typeof sharedWater !== 'object') return localWater;
  if (!localWater || typeof localWater !== 'object') return sharedWater;
  return {
    ...sharedWater,
    available: sharedWater.available || localWater.available,
    irrigationTodayLiters: localWater.irrigationTodayLiters,
    irrigationTodayNetMm: localWater.irrigationTodayNetMm,
    irrigationTodayMeasuredLiters: localWater.irrigationTodayMeasuredLiters,
    irrigationTodayEstimatedLiters: localWater.irrigationTodayEstimatedLiters,
    measuredIrrigationNetMm: localWater.measuredIrrigationNetMm,
    estimatedIrrigationNetMm: localWater.estimatedIrrigationNetMm,
    daily: mergeDailyIrrigationSplit(sharedWater.daily, localWater.daily)
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
  deriveCropCoefficient,
  estimateStepHours,
  sumRain,
  buildForecastSection,
  buildAgronomic,
  localDateIso,
  addUtcDays,
  toEffectiveIrrigationMm,
  buildSensorHealth,
  resolveWaterAction,
  mergeDailyIrrigationSplit,
  overlayLocalWaterIrrigationSplit,
};
