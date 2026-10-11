import type {ReadingSample} from './readings';

export type AggregationLevel = 'raw' | '15m' | 'hourly' | 'daily' | 'weekly';
export type AggregatedPoint = {t: string; value: number | null; count: number; coveragePct: number | null; coverageConfidence: 'unknown' | 'derived'; quality: string | null;
  bucketStart?: string; bucketEnd?: string; min?: number | null; max?: number | null; mean?: number | null; median?: number | null; latest?: number | null; expected?: number | null};
const bucketSeconds: Record<Exclude<AggregationLevel, 'raw'>, number> = {'15m': 900, hourly: 3600, daily: 86400, weekly: 604800};
const latestChannels = new Set(['rain_mm_today', 'rain_count_cumulative', 'rain_gauge_cumulative_mm', 'flow_liters_today', 'flow_count_cumulative', 'valve_1_pulse', 'valve_2_pulse']);
const sumChannels = new Set(['rain_mm_delta', 'rain_tips_delta', 'flow_liters_delta', 'flow_pulses_delta']);
const localMidnightCache = new Map<string, number>();
const dateParts = (at: number, timezone: string) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: timezone,
  year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(at)).map(part => [part.type, part.value]));
export function localDateKey(at: number, timezone: string): string {
  const p = dateParts(at, timezone); return `${p.year}-${p.month}-${p.day}`;
}
export function shiftDate(date: string, count: number): string {
  const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y!, m! - 1, d! + count)).toISOString().slice(0, 10);
}
export function channelAggregationStatistic(channel: string): 'mean' | 'latest' | 'sum' {
  return sumChannels.has(channel) ? 'sum' : latestChannels.has(channel) ? 'latest' : 'mean';
}
/** First millisecond whose local calendar date is the requested date (or the next extant date if skipped). */
export function localMidnight(date: string, timezone: string): number {
  const cacheKey = `${timezone}|${date}`, cached = localMidnightCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let low = Date.parse(`${date}T12:00:00.000Z`) - 36 * 3600000;
  let high = Date.parse(`${date}T12:00:00.000Z`) + 36 * 3600000;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDateKey(middle, timezone) >= date) high = middle;
    else low = middle + 1;
  }
  if (localMidnightCache.size >= 512) localMidnightCache.delete(localMidnightCache.keys().next().value!);
  localMidnightCache.set(cacheKey, low);
  return low;
}
export function resolveAggregation(requestedRaw: string, label: string, from: number, to: number): {requested: string; applied: AggregationLevel; bucketSizeSeconds: number | null} {
  const requested = (requestedRaw || 'auto').trim().toLowerCase();
  if (requested !== 'auto' && !['raw', '15m', 'hourly', 'daily', 'weekly'].includes(requested)) throw Object.assign(new Error('unsupported aggregation'), {code: 'invalid_aggregation'});
  let applied: AggregationLevel = requested === 'auto' ? 'raw' : requested as AggregationLevel;
  if (requested === 'auto') {
    const seconds = (to - from) / 1000;
    if (label === '7d') applied = 'hourly';
    else if (label === '30d') applied = 'daily';
    else if (label === 'season') applied = seconds > 120 * 86400 ? 'weekly' : 'daily';
    else if (seconds > 120 * 86400) applied = 'weekly';
    else if (seconds > 8 * 86400) applied = 'daily';
    else if (seconds > 48 * 3600) applied = 'hourly';
    else if (seconds > 24 * 3600) applied = '15m';
  }
  return {requested, applied, bucketSizeSeconds: applied === 'raw' ? null : bucketSeconds[applied]};
}
function channelValue(sample: ReadingSample, channel: string): number | null {
  const value = sample.values[channel]; return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function summarize(values: number[]): {min: number | null; max: number | null; mean: number | null; median: number | null; sum: number | null; latest: number | null} {
  if (!values.length) return {min: null, max: null, mean: null, median: null, sum: null, latest: null};
  const sorted = [...values].sort((a, b) => a - b), sum = values.reduce((a, b) => a + b, 0), mean = sum / values.length;
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return {min: sorted[0]!, max: sorted[sorted.length - 1]!, mean: Number(mean.toFixed(3)), median: Number(median.toFixed(3)), sum: Number(sum.toFixed(3)), latest: values[values.length - 1]!};
}
function cadence(samples: ReadingSample[]): number | null {
  const diffs = samples.slice(1).map((sample, index) => sample.at - samples[index]!.at).filter(value => value > 0 && value < 86400000).sort((a, b) => a - b);
  return diffs.length ? diffs[Math.floor(diffs.length / 2)]! : null;
}
function endOfBucket(start: number, level: Exclude<AggregationLevel, 'raw'>, timezone: string): number {
  if (level !== 'daily') return start + bucketSeconds[level] * 1000;
  return localMidnight(shiftDate(localDateKey(start, timezone), 1), timezone);
}
export function aggregateChannel(samples: ReadingSample[], channel: string, from: number, to: number, level: AggregationLevel, timezone: string, now: number) {
  const rows = samples.filter(sample => sample.at >= from && sample.at < to && channelValue(sample, channel) !== null).sort((a, b) => a.at - b.at);
  const cadenceMs = cadence(samples.filter(sample => sample.at <= now && channelValue(sample, channel) !== null).sort((a, b) => a.at - b.at));
  if (level === 'raw') return {points: rows.map(sample => ({t: new Date(sample.at).toISOString(), value: channelValue(sample, channel), count: 1,
    coveragePct: null as number | null, coverageConfidence: 'unknown' as const, quality: null as string | null})), coveragePct: null as number | null,
    coverageConfidence: cadenceMs ? 'derived' as const : 'unknown' as const, observedCount: rows.length, expectedCount: null as number | null,
    expectedCadenceSeconds: cadenceMs === null ? null : cadenceMs / 1000, truncated: rows.length > 2000};
  const buckets: Array<{start: number; end: number; rows: ReadingSample[]}> = [];
  let start = from;
  while (start < to && buckets.length < 30000) {
    const candidateEnd = endOfBucket(start, level, timezone);
    const end = Math.min(to, candidateEnd > start ? candidateEnd : start + bucketSeconds[level] * 1000);
    buckets.push({start, end, rows: []});
    start = end;
  }
  let cursor = 0;
  for (const bucket of buckets) {
    while (cursor < rows.length && rows[cursor]!.at < bucket.end) {
      if (rows[cursor]!.at >= bucket.start) bucket.rows.push(rows[cursor]!);
      cursor++;
    }
  }
  let observedCount = 0, expectedCount = 0;
  const points: AggregatedPoint[] = buckets.map(bucket => {
    const values = bucket.rows.map(row => channelValue(row, channel)!);
    const summary = summarize(values);
    const elapsed = Math.max(0, Math.min(bucket.end, now, to) - bucket.start);
    const expected = cadenceMs !== null && elapsed > 0 ? Math.max(1, Math.ceil(elapsed / cadenceMs)) : null;
    const coveragePct = expected !== null ? Math.min(100, Math.round(values.length / expected * 100)) : null;
    observedCount += values.length;
    if (expected !== null) expectedCount += expected;
    const statistic = channelAggregationStatistic(channel);
    const value = statistic === 'sum' ? summary.sum : statistic === 'latest' ? summary.latest : summary.mean;
    return {t: new Date(bucket.start).toISOString(), bucketStart: new Date(bucket.start).toISOString(), bucketEnd: new Date(bucket.end).toISOString(),
      value, min: summary.min, max: summary.max, mean: summary.mean, median: summary.median, latest: summary.latest,
      count: values.length, expected, coveragePct, coverageConfidence: cadenceMs ? 'derived' : 'unknown', quality: values.length ? 'ok' : 'gap'};
  });
  const elapsedMs = Math.max(0, Math.min(to, now) - from);
  const expectedTotal = cadenceMs !== null && elapsedMs > 0 ? Math.max(1, Math.ceil(elapsedMs / cadenceMs)) : null;
  const totalCoverage = expectedTotal === null ? null : Math.min(100, Math.round(observedCount / expectedTotal * 100));
  return {points, coveragePct: totalCoverage, coverageConfidence: cadenceMs ? 'derived' as const : 'unknown' as const,
    observedCount, expectedCount: expectedTotal, expectedCadenceSeconds: cadenceMs === null ? null : cadenceMs / 1000, truncated: start < to || points.length > 2000};
}
