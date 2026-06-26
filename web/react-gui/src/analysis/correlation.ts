import { canonicalize } from '../channels/registry';
import type { AnalysisSeries } from './types';

export const MIN_CORRELATION_SAMPLES = 30;

export interface CorrelationGroup {
  zoneId: number | null;
  label: string;
  n: number;
  droppedPairs: number;
  r: number | null;
  suppressed: boolean;
}

export interface CorrelationResult {
  groups: CorrelationGroup[];
  pooled: CorrelationGroup | null;
}

export interface ZonePairs {
  zoneId: number;
  label: string;
  points: [number, number][];
}

interface ZoneChannels {
  x?: AnalysisSeries;
  y?: AnalysisSeries;
  label: string;
}

interface Pair {
  x: number;
  y: number;
}

function pearson(pairs: Pair[]): number | null {
  const n = pairs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pairs) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    syy += p.y * p.y;
    sxy += p.x * p.y;
  }
  const cov = n * sxy - sx * sy;
  const dx = n * sxx - sx * sx;
  const dy = n * syy - sy * sy;
  const denom = Math.sqrt(dx * dy);
  if (denom === 0) return null;
  return cov / denom;
}

/** Pairwise deletion over index-aligned buckets (series share the canonical grid). */
function pairsFor(xSeries: AnalysisSeries, ySeries: AnalysisSeries): { pairs: Pair[]; dropped: number } {
  const len = Math.min(xSeries.points.length, ySeries.points.length);
  const pairs: Pair[] = [];
  let dropped = 0;
  for (let i = 0; i < len; i++) {
    const x = xSeries.points[i].value;
    const y = ySeries.points[i].value;
    if (x === null || y === null) {
      dropped += 1;
      continue;
    }
    pairs.push({ x, y });
  }
  return { pairs, dropped };
}

function groupByZone(series: AnalysisSeries[], channelX: string, channelY: string, zoneNames?: Map<number, string>): Map<number, ZoneChannels> {
  const canonicalX = canonicalize(channelX);
  const canonicalY = canonicalize(channelY);
  const byZone = new Map<number, ZoneChannels>();
  for (const item of series) {
    const zoneId = item.resolved.zoneId;
    const entry: ZoneChannels = byZone.get(zoneId) ?? { label: zoneNames?.get(zoneId)?.trim() || `Zone ${zoneId}` };
    const channelKey = canonicalize(item.resolved.channelKey);
    if (channelKey === canonicalX) entry.x = item;
    if (channelKey === canonicalY) entry.y = item;
    byZone.set(zoneId, entry);
  }
  return byZone;
}

export function zonePairs(series: AnalysisSeries[], channelX: string, channelY: string, zoneNames?: Map<number, string>): ZonePairs[] {
  const out: ZonePairs[] = [];
  for (const [zoneId, entry] of groupByZone(series, channelX, channelY, zoneNames)) {
    if (!entry.x || !entry.y) continue;
    const { pairs } = pairsFor(entry.x, entry.y);
    out.push({ zoneId, label: entry.label, points: pairs.map((p) => [p.x, p.y]) });
  }
  return out;
}

export function computeCorrelation(
  series: AnalysisSeries[],
  channelX: string,
  channelY: string,
  opts: { pooled?: boolean; minSamples?: number; zoneNames?: Map<number, string> } = {},
): CorrelationResult {
  const minSamples = opts.minSamples ?? MIN_CORRELATION_SAMPLES;
  const byZone = groupByZone(series, channelX, channelY, opts.zoneNames);

  const groups: CorrelationGroup[] = [];
  const allPairs: Pair[] = [];
  let pooledDroppedPairs = 0;
  for (const [zoneId, entry] of byZone) {
    if (!entry.x || !entry.y) continue;
    const { pairs, dropped } = pairsFor(entry.x, entry.y);
    allPairs.push(...pairs);
    pooledDroppedPairs += dropped;
    const suppressed = pairs.length < minSamples;
    groups.push({
      zoneId,
      label: entry.label,
      n: pairs.length,
      droppedPairs: dropped,
      r: suppressed ? null : pearson(pairs),
      suppressed,
    });
  }

  let pooled: CorrelationGroup | null = null;
  if (opts.pooled) {
    const suppressed = allPairs.length < minSamples;
    pooled = {
      zoneId: null,
      label: 'Pooled (all zones)',
      n: allPairs.length,
      droppedPairs: pooledDroppedPairs,
      r: suppressed ? null : pearson(allPairs),
      suppressed,
    };
  }

  return { groups, pooled };
}
