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
