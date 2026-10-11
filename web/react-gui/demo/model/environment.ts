import type {Device, IrrigationZone, ZoneEnvironmentSummary, WaterDay} from '../../src/types/farming';
import type {ReadingLedger} from './readings';
import type {ReadingSample} from './readings';
import type {RetainedEnvironmentRecord} from './state';
import {localDateKey, localMidnight, shiftDate} from './aggregation';
import {environmentFixture, iso} from '../fixtures';
import {resolveKc} from '../../src/agronomy/cropKc';
import {DAILY_AGRONOMY_SOURCE_KEY} from '../../src/analysis/types';

const CHANNELS: Record<string, {label: string; unit: string}> = {
  ambient_temperature: {label: 'Air temperature', unit: '°C'},
  relative_humidity: {label: 'Relative humidity', unit: '%'},
  ext_temperature_c: {label: 'Soil temperature', unit: '°C'},
  barometric_pressure_hpa: {label: 'Air pressure', unit: 'hPa'},
  wind_speed_mps: {label: 'Wind speed', unit: 'm/s'},
};
const round = (value: number) => Number(value.toFixed(2));

function cropCoefficient(zone: IrrigationZone, date: string): {kc: number; source: string; stage: string | null} {
  const resolved = resolveKc({cropType: zone.crop_type, phenologicalStage: zone.phenological_stage,
    stageStartedOn: zone.stage_started_on, date});
  return {kc: resolved.kc, source: resolved.kcSource, stage: resolved.stage};
}

export function selectedWeatherProvider(zone: IrrigationZone): 'open_meteo' | 'meteoswiss' | null {
  const selected = String(zone.weather_source ?? zone.weatherSource ?? 'auto').trim().toLowerCase();
  if (selected === 'local') return null;
  if (selected === 'open_meteo' || selected === 'meteoswiss') return selected;
  const fallback = String(zone.weather_source_default ?? zone.weatherSourceDefault ?? 'open_meteo').trim().toLowerCase();
  return fallback === 'meteoswiss' ? 'meteoswiss' : 'open_meteo';
}

export function hasIllustrativeWeatherSource(zone: IrrigationZone): boolean {
  return selectedWeatherProvider(zone) !== null && hasValidWeatherLocation(zone);
}

export function hasValidWeatherLocation(zone: IrrigationZone): boolean {
  return Number.isFinite(zone.latitude) && Number.isFinite(zone.longitude)
    && Math.abs(Number(zone.latitude)) <= 90 && Math.abs(Number(zone.longitude)) <= 180;
}

function weather(date: string, provider: 'open_meteo' | 'meteoswiss' | null) {
  const dayNumber = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  if (!provider) return null;
  // These are date-keyed fictional provider input records. Provider modes use
  // distinct deterministic fixture series; they never claim fetched data.
  const et0 = round(Math.max(1.2, provider === 'meteoswiss'
    ? 3.25 + Math.sin((dayNumber + 2) / 4.1) * 0.62
    : 3.1 + Math.sin(dayNumber / 3.7) * 0.8));
  const rain = ((dayNumber + (provider === 'meteoswiss' ? 1 : 0)) % 4 + 4) % 4 === 0 ? 1.6 : 0;
  const maxTemp = round((provider === 'meteoswiss' ? 23.8 : 25) + Math.sin((dayNumber + (provider === 'meteoswiss' ? 3 : 0)) / 5) * 3);
  return {et0, rain, maxTemp};
}

function recordFor(zone: IrrigationZone, date: string, timezone: string, now: number,
  retained?: Map<string, RetainedEnvironmentRecord>): RetainedEnvironmentRecord {
  const key = `${zone.id}|${date}|${DAILY_AGRONOMY_SOURCE_KEY}`;
  const today = localDateKey(now, timezone);
  const existing = retained?.get(key);
  if (existing && date < today && typeof existing.values.et0_mm === 'number') return structuredClone(existing);
  if (existing && date < today && (!hasValidWeatherLocation(zone) || selectedWeatherProvider(zone) === null)) return structuredClone(existing);
  const hasLocation = hasValidWeatherLocation(zone);
  const provider = hasLocation ? selectedWeatherProvider(zone) : null;
  const input = weather(date, provider);
  const kc = input ? cropCoefficient(zone, date) : null;
  const dayStart = localMidnight(date, timezone), dayEnd = localMidnight(shiftDate(date, 1), timezone);
  const firstUtcHour = Math.floor(dayStart / 3600000) * 3600000;
  const hourStarts: number[] = [];
  for (let at = firstUtcHour; at < dayEnd; at += 3600000) {
    if (localDateKey(at, timezone) === date) hourStarts.push(at);
  }
  const expectedHours = hourStarts.length;
  const hourly = input && expectedHours > 0 ? hourStarts.map(at => ({at, et0Mm: input.et0 / expectedHours})) : [];
  const locationKey = provider && Number.isFinite(zone.latitude) && Number.isFinite(zone.longitude)
    ? `${provider}:${Number(zone.latitude).toFixed(2)}:${Number(zone.longitude).toFixed(2)}` : null;
  const record: RetainedEnvironmentRecord = {date, provider, timezone, sampleAt: date < today ? dayStart + 12 * 3600000 : Math.min(now, dayStart + 12 * 3600000),
    dayStart, dayEnd, hourly, values: {et0_mm: input?.et0 ?? null,
    etc_mm: input && kc ? round(input.et0 * kc.kc) : null, forecast_rain_mm: input?.rain ?? null,
    air_temperature_c: input?.maxTemp ?? null, relative_humidity_pct: input ? 62 : null,
    et0_source: provider ? `${provider}_hourly_sum` : null, et0_tier: provider ? 'provider_hourly_sum' : null,
    location_key: locationKey, source_provider: provider, source_captured_at: iso(now),
    hours_present: hourly.length, expected_hours: expectedHours, coverage_pct: provider && expectedHours > 0 ? 100 : null,
    null_reason: provider ? null : hasLocation ? 'no_source' : 'no_location'}, provenance: {cropType: zone.crop_type ?? null,
      stage: kc?.stage ?? null, stageStartedOn: zone.stage_started_on ?? null, areaM2: Number.isFinite(zone.area_m2) ? Number(zone.area_m2) : null,
      efficiencyPct: Number.isFinite(zone.irrigation_efficiency_pct) ? Number(zone.irrigation_efficiency_pct) : null,
      kc: kc?.kc ?? null, kcSource: kc?.source ?? null, capturedAt: iso(now)}};
  if (retained && date < today && (existing === undefined || typeof existing.values.et0_mm !== 'number' && typeof record.values.et0_mm === 'number')) {
    retained.set(key, structuredClone(record));
  }
  return record;
}

export function seedCompletedEnvironmentRecords(zones: IrrigationZone[], now: number, timezone: string,
  retained: Map<string, RetainedEnvironmentRecord>, days = 92): void {
  for (const zone of zones) {
    const zoneTimezone = zone.timezone ?? timezone;
    const today = localDateKey(now, zoneTimezone);
    for (let offset = days; offset >= 1; offset--) {
      const date = shiftDate(today, -offset);
      recordFor(zone, date, zoneTimezone, now, retained);
    }
  }
}

export function syntheticEnvironmentTimeline(zone: IrrigationZone, from: number, to: number, timezone: string, now: number,
  retained?: Map<string, RetainedEnvironmentRecord>): ReadingSample[] {
  if (to < from) return [];
  if (!hasIllustrativeWeatherSource(zone)) return [];
  const first = localDateKey(from, timezone), last = localDateKey(to, timezone);
  const rows: ReadingSample[] = [];
  const recordedDates = new Set<string>();
  const prefix = `${zone.id}|`;
  if (retained) for (const [key, record] of retained) {
    if (!key.startsWith(prefix) || record.sampleAt < from || record.sampleAt > to || typeof record.values.et0_mm !== 'number') continue;
    recordedDates.add(record.date);
    rows.push({deviceEui: `ENVIRONMENT_ZONE_${zone.id}`, at: record.sampleAt, source: 'synthetic', values: {...record.values,
      crop_type: record.provenance.cropType, phenological_stage: record.provenance.stage, kc: record.provenance.kc,
      kc_source: record.provenance.kcSource, source_provider: record.provider}});
  }
  for (let date = first; date <= last; date = shiftDate(date, 1)) {
    if (recordedDates.has(date)) continue;
    const record = recordFor(zone, date, timezone, now, retained);
    if (record.sampleAt < from || record.sampleAt > to || typeof record.values.et0_mm !== 'number') continue;
    rows.push({deviceEui: `ENVIRONMENT_ZONE_${zone.id}`, at: record.sampleAt, source: 'synthetic', values: {...record.values,
      crop_type: record.provenance.cropType, phenological_stage: record.provenance.stage, kc: record.provenance.kc,
      kc_source: record.provenance.kcSource, source_provider: record.provider}});
  }
  return rows.sort((a, b) => a.at - b.at);
}

function syntheticDays(zone: IrrigationZone, measured: WaterDay[], now: number, timezone: string,
  retained?: Map<string, RetainedEnvironmentRecord>) {
  const dateKey = (value: number) => new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(value));
  const currentDate = dateKey(now);
  const byDate = new Map(measured.map(day => [day.date, day]));
  const current = new Date(`${currentDate}T12:00:00Z`);
  const days = Array.from({length: 7}, (_, index) => {
    const date = new Date(current.getTime() + (index - 6) * 86400000).toISOString().slice(0, 10);
    const record = recordFor(zone, date, timezone, now, retained);
    const input = record.values;
    const et0 = typeof input.et0_mm === 'number' ? input.et0_mm : null;
    const demand = typeof input.etc_mm === 'number' ? input.etc_mm : null;
    const forecastRain = typeof input.forecast_rain_mm === 'number' ? input.forecast_rain_mm : null;
    const kc = typeof record.provenance.kc === 'number' ? record.provenance.kc : null;
    const actual = byDate.get(date);
    const rainMm = actual?.rainMm ?? null;
    const area = Number.isFinite(zone.area_m2) ? Number(zone.area_m2) : null;
    const efficiency = Number.isFinite(zone.irrigation_efficiency_pct) ? Number(zone.irrigation_efficiency_pct) : null;
    const gross = actual?.irrigationLiters ?? null;
    const net = gross == null || !area || efficiency == null ? null : round(gross * efficiency / 100 / area);
    const total = rainMm == null || net == null ? null : round(rainMm + net);
    return {...actual, date, rainMm, forecastRainMm: forecastRain,
      irrigationLiters: actual?.irrigationLiters ?? null,
      measuredIrrigationLiters: actual?.measuredIrrigationLiters ?? null,
      irrigationNetMm: net, totalWaterMm: total,
      demandMm: demand, demandSource: demand === null ? null : date < currentDate ? 'calculated' as const : 'forecast' as const,
      et0Mm: et0, et0Source: et0 === null || date === currentDate ? null : String(input.et0_source),
      et0Tier: et0 === null || date === currentDate ? null : 'provider_hourly_sum' as const,
      sourceProvider: record.provider, sourceCapturedAt: input.source_captured_at as string, locationKey: input.location_key as string | null,
      sourceAvailable: et0 !== null, coveragePct: date === currentDate ? null : input.coverage_pct as number | null,
      kc, kcSource: record.provenance.kcSource, cropType: record.provenance.cropType,
      phenologicalStage: record.provenance.stage, stageStartedOn: record.provenance.stageStartedOn,
      areaM2: record.provenance.areaM2, irrigationEfficiencyPct: record.provenance.efficiencyPct,
      hoursPresent: date === currentDate ? null : Number(input.hours_present ?? 0),
      expectedHours: date === currentDate ? null : Number(input.expected_hours ?? 0),
      nullReason: demand === null && date === currentDate ? 'demand_unknown' : input.null_reason as string | null,
      estimatedTotalWaterMm: null,
    };
  });
  return {days, currentDate};
}

function localEnvironment(devices: Device[], ledger: ReadingLedger, now: number) {
  const from = now - 24 * 3600000;
  const samples = devices.flatMap(device => ledger.forDevice(device.deveui).filter(sample => sample.at >= from && sample.at <= now)
    .map(sample => ({device, sample})));
  const keys = [...new Set(samples.flatMap(row => Object.keys(row.sample.values).filter(key => key in CHANNELS)))];
  const metrics = keys.flatMap(key => {
    const values = samples.map(row => row.sample.values[key]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (!values.length) return [];
    const sorted = [...values].sort((a,b) => a-b);
    return [{key, ...CHANNELS[key]!, mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
      median: round(sorted[Math.floor((sorted.length - 1) / 2)]!), min: sorted[0]!, max: sorted[sorted.length - 1]!, sampleCount: values.length}];
  });
  const latestAt = samples.length ? Math.max(...samples.map(row => row.sample.at)) : null;
  const localDevices = devices.flatMap(device => {
    const deviceSamples = ledger.forDevice(device.deveui).filter(sample => sample.at >= from && sample.at <= now);
    const latest = deviceSamples[deviceSamples.length - 1];
    if (!latest) return [];
    const values = Object.fromEntries(Object.entries(latest.values).filter(([key, value]) => key in CHANNELS && typeof value === 'number')) as Record<string, number>;
    return Object.keys(values).length ? [{deviceEui: device.deveui, name: device.name, type: device.type_id, observedAt: iso(latest.at), metrics: values}] : [];
  });
  return {available: metrics.length > 0, observedAt: latestAt == null ? null : iso(latestAt), sensorCount: localDevices.length,
    freshSensorCount: localDevices.length, staleSensorCount: 0, metrics, devices: localDevices};
}

export function buildEnvironmentSummary(zone: IrrigationZone, devices: Device[], ledger: ReadingLedger, now: number, timezone: string,
  measuredDays: WaterDay[], retained?: Map<string, RetainedEnvironmentRecord>): ZoneEnvironmentSummary {
  const base = environmentFixture(zone, devices);
  const {days, currentDate} = syntheticDays(zone, measuredDays, now, timezone, retained);
  const current = days.find(day => day.date === currentDate)!;
  const provider = hasIllustrativeWeatherSource(zone) ? selectedWeatherProvider(zone) : null;
  const currentWeather = provider ? weather(currentDate, provider) : null;
  const fullForecast = buildForecast(zone, currentDate, now, timezone, provider, retained);
  const forecast = fullForecast ? {...fullForecast, hourly: fullForecast.hourly.filter(row => {
    const at = Date.parse(row.time); return at >= now && at < now + 24 * 3600000;
  }).slice(0, 24)} : null;
  const availability = provider !== null && currentWeather !== null;
  current.forecastRainMm = forecast?.daily.find(row => row.date === currentDate)?.rainMm ?? null;
  const summary: ZoneEnvironmentSummary = {
    ...base, generatedAt: iso(now),
    location: {latitude: zone.latitude ?? null, longitude: zone.longitude ?? null, timezone, source: hasValidWeatherLocation(zone) ? 'zone' : 'unavailable'},
    display: {...base.display!, sourceLabel: availability ? `Illustrative simulator · ${provider}` : 'Illustrative simulator · unavailable'},
    local: localEnvironment(devices, ledger, now),
    water: {...base.water, areaM2: zone.area_m2 ?? null, irrigationEfficiencyPct: zone.irrigation_efficiency_pct ?? null,
      todayDate: currentDate, next24hRainMm: forecast?.totalNext24hMm ?? null, waterNeededTodayMm: current.demandMm ?? null,
      balanceTodayMm: current.totalWaterMm == null || current.demandMm == null ? null : round(current.totalWaterMm - current.demandMm),
      daily: days},
    online: {...base.online, available: availability, source: availability ? provider : 'unavailable',
      cacheStatus: availability ? 'live' : 'miss', observedAt: availability ? iso(now) : null,
      expiresAt: availability ? iso(now + 15 * 60_000) : null,
      current: availability && currentWeather ? {description: `Illustrative ${provider} simulator input`, weatherCode: null, airTemperatureC: currentWeather.maxTemp,
        relativeHumidityPct: 62, pressureHpa: null, windSpeedMps: 1.1, windDirectionDeg: null,
        cloudCoverPct: null, rainMm: currentWeather.rain, precipitationProbabilityPct: currentWeather.rain > 0 ? 40 : 10} : null},
    agronomic: {...base.agronomic, preferredSource: availability ? `Illustrative ${provider}` : 'unavailable', current: availability && currentWeather ? {thermodynamicSource: 'illustrative',
      evapotranspirationSource: 'Illustrative simulator', cropCoefficientSource: 'Illustrative crop coefficient',
      airTemperatureC: currentWeather.maxTemp, relativeHumidityPct: 62, vpdKpa: 1.1, dewPointC: 17, heatIndexC: currentWeather.maxTemp,
      thi: 67, referenceEt0MmDay: current.et0Mm ?? null, cropCoefficientKc: current.kc ?? null, etcMmDay: current.demandMm ?? null} : null},
    forecast: {...base.forecast, available: forecast !== null, source: forecast ? provider as 'open_meteo' | 'meteoswiss' : 'unavailable',
      cacheStatus: forecast ? 'live' : 'miss', observedAt: forecast ? iso(now) : null,
      expiresAt: forecast ? iso(now + 15 * 60_000) : null, rainFocus: forecast},
  };
  return summary;
}

export function buildForecast(zone: IrrigationZone, currentDate: string, now: number, timezone: string,
  provider: 'open_meteo' | 'meteoswiss' | null, retained?: Map<string, RetainedEnvironmentRecord>) {
  if (!provider || !hasIllustrativeWeatherSource(zone)) return null;
  const firstHour = Math.floor(now / 3600000) * 3600000 + 3600000;
  const hourly = Array.from({length: 72}, (_, index) => {
    const at = firstHour + index * 3600000;
    const date = localDateKey(at, timezone), hour = new Date(at).getUTCHours();
    const daily = weather(date, provider)!;
    const dayNumber = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
    const rainStartHour = (dayNumber + (provider === 'meteoswiss' ? 5 : 0)) % 24;
    const rainOffset = (hour - rainStartHour + 24) % 24;
    const wet = daily.rain > 0 && rainOffset < 4;
    return {time: iso(at), rainMm: wet ? 0.4 : 0, rainProbabilityPct: wet ? 45 : 8,
      tempC: round(daily.maxTemp - Math.abs(hour - 14) * 0.35), windSpeedMps: 1.1};
  });
  const daily = [0, 1, 2].map(offset => {
    const date = shiftDate(currentDate, offset);
    const record = recordFor(zone, date, timezone, now, retained);
    const dayHours = hourly.filter(row => localDateKey(Date.parse(row.time), timezone) === date);
    const rain = Number(dayHours.reduce((sum, row) => sum + (row.rainMm ?? 0), 0).toFixed(2));
    const temperatures = dayHours.flatMap(row => row.tempC == null ? [] : [row.tempC]);
    return {date, description: `Illustrative ${provider} simulator input`, weatherCode: null,
      maxTempC: temperatures.length ? Math.max(...temperatures) : null,
      minTempC: temperatures.length ? Math.min(...temperatures) : null, rainMm: rain,
      rainProbabilityPct: dayHours.length ? (rain > 0 ? 45 : 8) : null, windSpeedMps: 1.1,
      et0MmDay: typeof record.values.et0_mm === 'number' ? record.values.et0_mm : null,
      etcMmDay: typeof record.values.etc_mm === 'number' ? record.values.etc_mm : null};
  });
  const next24 = hourly.filter(row => Date.parse(row.time) >= now && Date.parse(row.time) < now + 24 * 3600000).slice(0, 24);
  const next72 = hourly.filter(row => Date.parse(row.time) >= now && Date.parse(row.time) < now + 72 * 3600000);
  const rainHours = hourly.filter(row => Date.parse(row.time) >= now && (row.rainMm ?? 0) > 0.05);
  const max = Math.max(0, ...hourly.map(row => row.rainMm ?? 0));
  return {totalNext24hMm: Number(next24.reduce((sum, row) => sum + (row.rainMm ?? 0), 0).toFixed(2)),
    totalNext72hMm: Number(next72.reduce((sum, row) => sum + (row.rainMm ?? 0), 0).toFixed(2)),
    maxHourlyRainMm: max, maxHourlyRainAt: max > 0 ? hourly.find(row => row.rainMm === max)?.time ?? null : null,
    nextRainEta: rainHours[0]?.time ?? null, rainHoursNext24h: next24.filter(row => (row.rainMm ?? 0) > 0.05).length, daily, hourly};
}
