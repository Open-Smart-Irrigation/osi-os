const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function roundWindDirectionDegrees(value: number | null | undefined): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const normalized = ((numeric % 360) + 360) % 360;
  return Math.round(normalized) % 360;
}

export function toCompassDirection(value: number | null | undefined): string | null {
  const rounded = roundWindDirectionDegrees(value);
  if (rounded == null) {
    return null;
  }
  return COMPASS_POINTS[Math.round(rounded / 22.5) % COMPASS_POINTS.length];
}

export function formatWindDirection(value: number | null | undefined, fallback = '—'): string {
  const rounded = roundWindDirectionDegrees(value);
  const compass = toCompassDirection(value);
  if (rounded == null || !compass) {
    return fallback;
  }
  return `${compass} ${rounded}°`;
}

export interface WindSample {
  wind_speed_mps: number | null;
  wind_direction_deg: number | null;
}

export interface WindSpeedBin {
  label: string;
  min: number;
  max: number | null;
  color: string;
}

export interface WindRoseSector {
  direction: string;
  bins: number[];
  totalPct: number;
}

export interface WindRose {
  sectors: WindRoseSector[];
  speedBins: WindSpeedBin[];
  validSamples: number;
  calmSamples: number;
  calmPct: number;
}

export interface WindRoseOptions {
  calmThreshold?: number;
  speedBins?: WindSpeedBin[];
}

export const DEFAULT_WIND_SPEED_BINS: WindSpeedBin[] = [
  { label: '<1', min: 0, max: 1, color: '#64748b' },
  { label: '1–2', min: 1, max: 2, color: '#2563eb' },
  { label: '2–3', min: 2, max: 3, color: '#06b6d4' },
  { label: '3–4', min: 3, max: 4, color: '#22c55e' },
  { label: '4–5', min: 4, max: 5, color: '#eab308' },
  { label: '5+', min: 5, max: null, color: '#dc2626' },
];

const DEFAULT_CALM_THRESHOLD = 0.5;

function speedBinIndex(speed: number, bins: WindSpeedBin[]): number {
  for (let i = 0; i < bins.length; i += 1) {
    const { min, max } = bins[i];
    if (speed >= min && (max == null || speed < max)) {
      return i;
    }
  }
  return bins.length - 1;
}

export function computeWindRose(samples: WindSample[], options: WindRoseOptions = {}): WindRose {
  const speedBins = options.speedBins ?? DEFAULT_WIND_SPEED_BINS;
  const calmThreshold = options.calmThreshold ?? DEFAULT_CALM_THRESHOLD;

  if (speedBins.length === 0) {
    throw new Error('speedBins must contain at least one bin');
  }

  const counts: number[][] = COMPASS_POINTS.map(() => speedBins.map(() => 0));
  let validSamples = 0;
  let calmSamples = 0;

  for (const sample of samples) {
    if (sample.wind_speed_mps == null || sample.wind_direction_deg == null) {
      continue;
    }

    const speed = Number(sample.wind_speed_mps);
    const direction = roundWindDirectionDegrees(sample.wind_direction_deg);
    if (!Number.isFinite(speed) || direction == null) {
      continue;
    }

    validSamples += 1;
    if (speed < calmThreshold) {
      calmSamples += 1;
      continue;
    }

    const compass = toCompassDirection(direction);
    const sectorIndex = compass ? COMPASS_POINTS.indexOf(compass) : -1;
    const binIndex = speedBinIndex(speed, speedBins);
    if (sectorIndex < 0 || binIndex < 0) {
      continue;
    }
    counts[sectorIndex][binIndex] += 1;
  }

  const denom = validSamples || 1;
  const sectors: WindRoseSector[] = COMPASS_POINTS.map((direction, sectorIndex) => {
    const bins = counts[sectorIndex].map((count) => (count / denom) * 100);
    return {
      direction,
      bins,
      totalPct: bins.reduce((total, value) => total + value, 0),
    };
  });

  return {
    sectors,
    speedBins,
    validSamples,
    calmSamples,
    calmPct: validSamples ? (calmSamples / validSamples) * 100 : 0,
  };
}
