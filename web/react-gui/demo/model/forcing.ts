const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const KAMPALA_OFFSET_MS = 3 * HOUR_MS;
const RAIN_CYCLE_ORIGIN_UTC = Date.parse('2026-10-09T21:00:00.000Z'); // 2026-10-10 00:00 in Kampala
const RAIN_CYCLE_DAYS = 13;
const SITE_ELEVATION_M = 1190; // fictional site metadata, not surveyed elevation

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const positiveModulo = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor;
const isFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Shared weather at one timestamp for the fictional Kampala demonstration site. */
export type Atmosphere = {
  daylightFraction: number;
  cloudFraction: number;
  airTemperatureC: number;
  dewPointC: number;
  relativeHumidityPct: number;
  lightLux: number;
  uvIndex: number;
  windSpeedMps: number;
  windGustMps: number;
  windDirectionDeg: number;
  stationPressureHpa: number;
};

function localDayIndexAt(timestampMs: number): number {
  return Math.floor((timestampMs - RAIN_CYCLE_ORIGIN_UTC) / DAY_MS);
}

function localHourAt(timestampMs: number): number {
  return positiveModulo(timestampMs + KAMPALA_OFFSET_MS, DAY_MS) / HOUR_MS;
}

type RainEvent = {startMs: number; endMs: number; amountMm: number};

function rainEventForLocalDay(dayIndex: number): RainEvent | null {
  const cycleDay = positiveModulo(dayIndex, RAIN_CYCLE_DAYS);
  const localDayStartUtc = RAIN_CYCLE_ORIGIN_UTC + dayIndex * DAY_MS;
  if (cycleDay === 2) {
    const startMs = localDayStartUtc + 1.5 * HOUR_MS;
    return {startMs, endMs: startMs + 1.5 * HOUR_MS, amountMm: 6};
  }
  if (cycleDay === 6) {
    const startMs = localDayStartUtc + 23.25 * HOUR_MS;
    return {startMs, endMs: startMs + HOUR_MS, amountMm: 4};
  }
  return null;
}

function rainRateMmPerHourAt(timestampMs: number): number {
  const dayIndex = localDayIndexAt(timestampMs);
  for (const candidateDay of [dayIndex - 1, dayIndex]) {
    const event = rainEventForLocalDay(candidateDay);
    if (event && timestampMs >= event.startMs && timestampMs < event.endMs) {
      return event.amountMm / ((event.endMs - event.startMs) / HOUR_MS);
    }
  }
  return 0;
}

/**
 * A simple 24-hour fictional site forcing, not a Kampala forecast. All inputs
 * are timestamps; the site's UTC+3 clock does not follow the display timezone.
 */
export function atmosphereAt(timestampMs: number): Atmosphere {
  if (!Number.isFinite(timestampMs)) throw new RangeError('Timestamp must be finite');
  const hour = localHourAt(timestampMs);
  const dayIndex = localDayIndexAt(timestampMs);
  const daylightFraction = hour < 6.5 || hour > 18.5
    ? 0
    : Math.max(0, Math.sin(Math.PI * (hour - 6.5) / 12));
  const rainRate = rainRateMmPerHourAt(timestampMs);
  const cloudFraction = clamp(
    0.28 + 0.1 * Math.cos(2 * Math.PI * (hour - 10) / 24) + 0.06 * Math.sin(dayIndex * 0.731) + (rainRate > 0 ? 0.42 : 0),
    0.12,
    0.92,
  );
  const diurnalTemperature = Math.cos(2 * Math.PI * (hour - 15) / 24);
  const airTemperatureC = 24.5 + (5.3 - 1.2 * cloudFraction) * diurnalTemperature - Math.min(4, rainRate) * 0.35;
  const dewPointC = Math.min(16.5 + 1.6 * cloudFraction + Math.min(2, rainRate * 0.35), airTemperatureC - 0.3);
  const saturationVaporPressure = (temperatureC: number) => Math.exp((17.625 * temperatureC) / (243.04 + temperatureC));
  const relativeHumidityPct = clamp(
    100 * saturationVaporPressure(dewPointC) / saturationVaporPressure(airTemperatureC),
    0,
    100,
  );
  const cloudTransmission = 1 - 0.65 * cloudFraction;
  const windSpeedMps = Math.max(0, 1.1 + 1.3 * daylightFraction + 0.2 * Math.sin(2 * Math.PI * (hour - 8) / 24));
  const gustFactor = 0.55 + 1.15 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (hour - 11) / 24));
  const windGustMps = windSpeedMps + gustFactor;
  const windDirectionDeg = positiveModulo(108 + Math.round(dayIndex * 17 + 42 * Math.sin(2 * Math.PI * hour / 24)), 360);
  const stationPressureHpa = 1013.25 * Math.pow(1 - (0.0065 * SITE_ELEVATION_M) / 288.15, 5.25588);

  return {
    daylightFraction,
    cloudFraction,
    airTemperatureC,
    dewPointC,
    relativeHumidityPct,
    lightLux: Math.round(35_000 * daylightFraction * cloudTransmission),
    uvIndex: Number((9 * daylightFraction * (1 - 0.8 * cloudFraction)).toFixed(2)),
    windSpeedMps: Number(windSpeedMps.toFixed(2)),
    windGustMps: Number(windGustMps.toFixed(2)),
    windDirectionDeg,
    stationPressureHpa: Number(stationPressureHpa.toFixed(1)),
  };
}

/**
 * Integrate shared physical rain over [startMs, endMs). The 13-local-day cycle
 * has 6 mm over 01:30–03:00 on cycle day 2 and 4 mm over 23:15–00:15 on day 6.
 * Uniform intensity within each illustrative event makes the integral exact
 * across report intervals and local midnight.
 */
export function rainfallMmBetween(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new RangeError('Interval timestamps must be finite');
  if (endMs <= startMs) return 0;

  const firstDay = localDayIndexAt(startMs) - 1;
  const lastDay = localDayIndexAt(endMs) + 1;
  let amountMm = 0;
  for (let dayIndex = firstDay; dayIndex <= lastDay; dayIndex += 1) {
    const event = rainEventForLocalDay(dayIndex);
    if (!event) continue;
    const overlapMs = Math.max(0, Math.min(endMs, event.endMs) - Math.max(startMs, event.startMs));
    if (overlapMs > 0) amountMm += event.amountMm * overlapMs / (event.endMs - event.startMs);
  }
  return Number(amountMm.toFixed(12));
}

/** Add physical rain since an explicit device baseline; pre-baseline reads stay at that baseline. */
export function rainCounterAt(timestampMs: number, baselineAtMs: number, baselineMm: number): number {
  if (!Number.isFinite(timestampMs) || !Number.isFinite(baselineAtMs)) throw new RangeError('Counter timestamps must be finite');
  if (!isFiniteNumber(baselineMm) || baselineMm < 0) throw new RangeError('Rain counter baseline must be nonnegative');
  if (timestampMs <= baselineAtMs) return baselineMm;
  return Number((baselineMm + rainfallMmBetween(baselineAtMs, timestampMs)).toFixed(12));
}

export type LoRainTips = {tips: number; rainMm: number; residualMm: number};

/** Convert received physical rain to LoRain's 0.5 mm tips, retaining unreported residual. */
export function quantizeLoRainTips(intervalRainMm: number, residualMm = 0): LoRainTips {
  if (!isFiniteNumber(intervalRainMm) || intervalRainMm < 0 || !isFiniteNumber(residualMm) || residualMm < 0 || residualMm >= 0.5) {
    throw new RangeError('Rain and residual must be nonnegative; residual must be below one tip');
  }
  const totalMm = intervalRainMm + residualMm;
  const tips = Math.floor((totalMm + 1e-10) / 0.5);
  const rainMm = tips * 0.5;
  const nextResidualMm = Number(Math.max(0, totalMm - rainMm).toFixed(10));
  return {tips, rainMm, residualMm: nextResidualMm};
}

/** Convert delivered liters to net millimetres using geometry captured at delivery time. */
export function netIrrigationMm(deliveredLiters: number, areaM2: number | null, efficiency: number | null): number | null {
  if (!isFiniteNumber(deliveredLiters) || deliveredLiters < 0) throw new RangeError('Delivered liters must be nonnegative');
  if (deliveredLiters === 0) return 0;
  if (!isFiniteNumber(areaM2) || areaM2 <= 0 || !isFiniteNumber(efficiency) || efficiency < 0 || efficiency > 1) return null;
  return deliveredLiters / areaM2 * efficiency;
}

export type SoilResponseChannel = {
  zoneId: string;
  installationId: string;
  depthClass: 'shallow' | 'deep';
  baselineAtMs: number;
  baselineKpa: number;
};

/**
 * An observed water event retains delivery liters and the geometry/efficiency
 * captured when it happened. Missing geometry never gets a physical default.
 */
export type WaterInput = {
  eventId: string;
  zoneId: string;
  installationId: string;
  atMs: number;
  rainMm: number;
  deliveredLiters: number;
  areaM2: number | null;
  efficiency: number | null;
};

export const FICTIONAL_SOIL_RESPONSE = {
  rainInfiltrationFraction: 0.65,
  shallow: {
    depthCm: 20,
    lagMinutes: 10,
    responseHours: 1,
    recoveryHours: 72,
    dryingKpaPerDay: 2,
    wettingKpaPerMm: 1.5,
    attenuation: 0.9,
  },
  deep: {
    depthCm: 40,
    lagMinutes: 150,
    responseHours: 3,
    recoveryHours: 120,
    dryingKpaPerDay: 1,
    wettingKpaPerMm: 0.8,
    attenuation: 0.55,
  },
} as const;

function responseAt(channel: SoilResponseChannel, timestampMs: number, inputs: readonly WaterInput[]): number | null {
  const profile = FICTIONAL_SOIL_RESPONSE[channel.depthClass];
  let totalResponseKpa = 0;
  const appliedEventIds = new Set<string>();
  for (const input of inputs) {
    if (input.zoneId !== channel.zoneId || input.installationId !== channel.installationId) continue;
    if (appliedEventIds.has(input.eventId)) continue;
    appliedEventIds.add(input.eventId);
    if (!Number.isFinite(input.atMs) || !isFiniteNumber(input.rainMm) || input.rainMm < 0) throw new RangeError('Water input timestamps and rain must be valid');
    const irrigationMm = netIrrigationMm(input.deliveredLiters, input.areaM2, input.efficiency);
    const ageHours = (timestampMs - input.atMs) / HOUR_MS - profile.lagMinutes / 60;
    if (ageHours <= 0) continue;
    if (irrigationMm === null) return null;
    const waterMm = input.rainMm * FICTIONAL_SOIL_RESPONSE.rainInfiltrationFraction + irrigationMm;
    if (waterMm === 0) continue;
    const arrival = 1 - Math.exp(-ageHours / profile.responseHours);
    const recovery = Math.exp(-ageHours / profile.recoveryHours);
    totalResponseKpa += waterMm * profile.wettingKpaPerMm * profile.attenuation * arrival * recovery;
  }
  return totalResponseKpa;
}

/**
 * Calculate a bounded illustrative tension at an arbitrary timestamp. The
 * baseline anchors exactly; wetting is delayed by depth and decays as the soil
 * dries. Depth labels in device configuration do not alter this fixed profile.
 */
export function soilTensionAt(channel: SoilResponseChannel, timestampMs: number, inputs: readonly WaterInput[]): number | null {
  if (!Number.isFinite(timestampMs) || !Number.isFinite(channel.baselineAtMs) ||
      !isFiniteNumber(channel.baselineKpa) || channel.baselineKpa < 0) {
    throw new RangeError('Soil baseline and timestamps must be valid');
  }
  const currentWetResponse = responseAt(channel, timestampMs, inputs);
  const anchorWetResponse = responseAt(channel, channel.baselineAtMs, inputs);
  if (currentWetResponse === null || anchorWetResponse === null) return null;
  const profile = FICTIONAL_SOIL_RESPONSE[channel.depthClass];
  const elapsedDays = (timestampMs - channel.baselineAtMs) / DAY_MS;
  const tension = channel.baselineKpa + profile.dryingKpaPerDay * elapsedDays - currentWetResponse + anchorWetResponse;
  return Number(clamp(tension, 0, 239).toFixed(3));
}

export const FICTIONAL_SITE_ELEVATION_M = SITE_ELEVATION_M;
