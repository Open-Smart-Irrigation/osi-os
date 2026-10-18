import type { HistorySeriesPoint } from './types';

export type HistoryChannelFamily = 'soil' | 'environment' | 'other';

export function classifyHistoryChannel(channelKey: unknown): HistoryChannelFamily {
  const key = typeof channelKey === 'string' ? channelKey.trim().toLowerCase() : '';
  if (/^(swt|vwc)(?:_\d+)?$/.test(key)) return 'soil';
  if (['ambient_temperature', 'relative_humidity', 'light_lux', 'wind_speed_mps', 'rain_mm_delta', 'rain_mm_per_hour'].includes(key)) {
    return 'environment';
  }
  return 'other';
}

export function historySeriesValue(point: Partial<HistorySeriesPoint> | null | undefined): number | null {
  if (!point || typeof point !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(point, 'value')) {
    return typeof point.value === 'number' && Number.isFinite(point.value) ? point.value : null;
  }
  for (const candidate of [point.latest, point.mean, point.median]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stableSuffix(series: Record<string, unknown>): string {
  const source = text(series.deviceSourceId) ?? text(series.sourceKey) ?? text(series.id) ?? 'source';
  return source.length > 12 ? source.slice(-12) : source;
}

function channelLabel(value: unknown): string | null {
  const key = text(value);
  if (!key) return null;
  return key
    .split('_')
    .map((part) => /^(swt|vwc)$/i.test(part)
      ? part.toUpperCase()
      : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function displayHistorySeriesLabel(
  series: Record<string, unknown>,
  allSeries: readonly Record<string, unknown>[],
): string {
  const label = text(series.sourceLabel) ?? text(series.label) ?? 'Source';
  const descriptor = [label, channelLabel(series.channelKey), typeof series.depthCm === 'number' ? `${series.depthCm} cm` : null].filter(Boolean).join(' · ');
  const sameLabel = allSeries.filter((candidate) =>
    [text(candidate.sourceLabel) ?? text(candidate.label) ?? 'Source', channelLabel(candidate.channelKey), typeof candidate.depthCm === 'number' ? `${candidate.depthCm} cm` : null].filter(Boolean).join(' · ') === descriptor,
  );
  return sameLabel.length > 1 ? `${descriptor} · ${stableSuffix(series)}` : descriptor;
}

export function historySeriesColor(id: string): string {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const unsigned = hash >>> 0;
  return `hsl(${unsigned % 360} ${55 + ((unsigned >>> 8) % 30)}% ${40 + ((unsigned >>> 16) % 20)}%)`;
}

export function historySeriesDash(id: string): string {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) % 3 === 0 ? '6 3' : (hash >>> 0) % 3 === 1 ? '3 2' : '0';
}
