import type { AnalysisRange } from './types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const RELATIVE_RANGE_MS: Record<string, number> = {
  '12h': 12 * HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
  season: 180 * DAY_MS,
};

export function resolveAnalysisRangeForRequest(
  range: AnalysisRange,
  now: Date = new Date(),
): AnalysisRange {
  if (range.from && range.to) return range;

  const durationMs = RELATIVE_RANGE_MS[range.label] ?? RELATIVE_RANGE_MS['7d'];
  const to = new Date(now.getTime());
  const from = new Date(to.getTime() - durationMs);

  return {
    ...range,
    mode: 'absolute',
    from: from.toISOString(),
    to: to.toISOString(),
  };
}
