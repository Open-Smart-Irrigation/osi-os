import { canonicalize } from '../channels/registry';
import type { AnalysisSeries } from './types';

export const MIN_CORRELATION_SAMPLES = 30;

export type CorrelationSuppressionReason = 'ambiguous' | 'missing_device_source';

export interface CorrelationGroup {
  groupId: string;
  zoneId: number | null;
  label: string;
  n: number;
  droppedPairs: number;
  r: number | null;
  suppressed: boolean;
  suppressionReason?: CorrelationSuppressionReason;
}

export interface CorrelationResult {
  groups: CorrelationGroup[];
  pooled: CorrelationGroup | null;
}

export interface ZonePairs {
  groupId: string;
  zoneId: number | null;
  label: string;
  points: [number, number][];
}

interface ZoneChannels {
  groupId: string;
  zoneId: number | null;
  label: string;
  x: AnalysisSeries[];
  y: AnalysisSeries[];
  missingDeviceSource: boolean;
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

function pairsFor(xSeries: AnalysisSeries, ySeries: AnalysisSeries): { pairs: Pair[]; dropped: number } {
  const yByTimestamp = new Map(ySeries.points.map((point) => [point.t, point.value]));
  const xTimestamps = new Set<string>();
  const pairs: Pair[] = [];
  let dropped = 0;
  for (const point of xSeries.points) {
    xTimestamps.add(point.t);
    if (!yByTimestamp.has(point.t)) {
      dropped += 1;
      continue;
    }
    const x = point.value;
    const y = yByTimestamp.get(point.t);
    if (x === null || y === null || y === undefined) {
      dropped += 1;
      continue;
    }
    pairs.push({ x, y });
  }
  for (const point of ySeries.points) {
    if (!xTimestamps.has(point.t)) dropped += 1;
  }
  return { pairs, dropped };
}

export function groupByZone(series: AnalysisSeries[], channelX: string, channelY: string, zoneNames?: Map<number, string>): Map<string, ZoneChannels> {
  const canonicalX = canonicalize(channelX);
  const canonicalY = canonicalize(channelY);
  const byGroup = new Map<string, ZoneChannels>();
  for (const item of series) {
    const zoneId = item.resolved.zoneId;
    const deviceSourceId = item.resolved.deviceSourceId ?? null;
    const groupId = zoneId !== null
      ? `zone:${zoneId}`
      : deviceSourceId
        ? `device:${deviceSourceId}`
        : `missing:${item.seriesId}`;
    const label = zoneId !== null
      ? zoneNames?.get(zoneId)?.trim() || `Zone ${zoneId}`
      : deviceSourceId
        ? item.label.split(' - ')[0] || 'Unassigned device'
        : 'Unassigned device';
    const entry = byGroup.get(groupId) ?? {
      groupId,
      zoneId,
      label,
      x: [],
      y: [],
      missingDeviceSource: zoneId === null && !deviceSourceId,
    };
    const channelKey = canonicalize(item.resolved.channelKey);
    if (channelKey === canonicalX) entry.x.push(item);
    if (channelKey === canonicalY) entry.y.push(item);
    byGroup.set(groupId, entry);
  }
  return byGroup;
}

function validPair(entry: ZoneChannels): { x: AnalysisSeries; y: AnalysisSeries } | null {
  if (entry.missingDeviceSource || entry.x.length !== 1 || entry.y.length !== 1) return null;
  return { x: entry.x[0], y: entry.y[0] };
}

export function zonePairs(series: AnalysisSeries[], channelX: string, channelY: string, zoneNames?: Map<number, string>): ZonePairs[] {
  const out: ZonePairs[] = [];
  for (const entry of groupByZone(series, channelX, channelY, zoneNames).values()) {
    const selected = validPair(entry);
    if (!selected) continue;
    const { pairs } = pairsFor(selected.x, selected.y);
    out.push({ groupId: entry.groupId, zoneId: entry.zoneId, label: entry.label, points: pairs.map((p) => [p.x, p.y]) });
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
  const byGroup = groupByZone(series, channelX, channelY, opts.zoneNames);
  const groups: CorrelationGroup[] = [];
  const allPairs: Pair[] = [];
  let pooledDroppedPairs = 0;
  for (const entry of byGroup.values()) {
    const selected = validPair(entry);
    if (!selected) {
      const suppressionReason: CorrelationSuppressionReason = entry.missingDeviceSource ? 'missing_device_source' : 'ambiguous';
      if (entry.x.length > 0 || entry.y.length > 0) {
        groups.push({ groupId: entry.groupId, zoneId: entry.zoneId, label: entry.label, n: 0, droppedPairs: 0, r: null, suppressed: true, suppressionReason });
      }
      continue;
    }
    const { pairs, dropped } = pairsFor(selected.x, selected.y);
    allPairs.push(...pairs);
    pooledDroppedPairs += dropped;
    const suppressed = pairs.length < minSamples;
    groups.push({ groupId: entry.groupId, zoneId: entry.zoneId, label: entry.label, n: pairs.length, droppedPairs: dropped, r: suppressed ? null : pearson(pairs), suppressed });
  }

  let pooled: CorrelationGroup | null = null;
  if (opts.pooled) {
    const suppressed = allPairs.length < minSamples;
    pooled = {
      groupId: 'pooled',
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
