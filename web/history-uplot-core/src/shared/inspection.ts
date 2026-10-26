import { HOUR_MS, MINUTE_MS, type MobileBucket, type Point, type SensorSeries, type Viewport } from './types';

export interface UnavailableInspection { kind: 'unavailable'; }
export interface ValueInspection {
  kind: 'value';
  value: number;
  sampledAt: number;
  unit: string;
  seriesId: string;
}
export type Inspection = UnavailableInspection | ValueInspection;
export interface BucketInspection { kind: 'bucket'; value: number; from: number; to: number; count: number; quality: string | null; unit: string; seriesId: string; }
export interface BucketUnavailableInspection { kind: 'bucket-unavailable'; from: number; to: number; count: number; quality: string | null; unit: string; seriesId: string; }

function nearest(points: readonly Point[], time: number): Point | undefined {
  let result: Point | undefined;
  let distance = Infinity;
  for (const point of points) {
    const nextDistance = Math.abs(point.t - time);
    if (nextDistance < distance) { result = point; distance = nextDistance; }
  }
  return result;
}

export function inspectAtTime(series: SensorSeries, time: number, viewport: Viewport): Inspection;
export function inspectAtTime(series: readonly SensorSeries[], time: number, viewport: Viewport): readonly Inspection[];
export function inspectAtTime(series: SensorSeries | readonly SensorSeries[], time: number, viewport: Viewport): Inspection | readonly Inspection[] {
  if (Array.isArray(series)) return series.map((item) => inspectAtTime(item, time, viewport));
  const item = series as SensorSeries;
  const tolerance = Math.min(6 * HOUR_MS, Math.max(5 * MINUTE_MS, (viewport.to - viewport.from) / 80));
  const point = nearest(item.points, time);
  if (!point || Math.abs(point.t - time) > tolerance || point.value === null) return { kind: 'unavailable' };
  return { kind: 'value', value: point.value, sampledAt: point.t, unit: item.unit, seriesId: item.id };
}

export function inspectBucketAtTime(seriesId: string, unit: string, buckets: readonly MobileBucket[], time: number): BucketInspection | BucketUnavailableInspection {
  const bucket = buckets.find((candidate) => time >= candidate.from && time < candidate.to);
  if (!bucket || bucket.value === null) return { kind: 'bucket-unavailable', from: bucket?.from ?? time, to: bucket?.to ?? time, count: bucket?.count ?? 0, quality: bucket?.quality ?? null, unit, seriesId };
  return { kind: 'bucket', value: bucket.value, from: bucket.from, to: bucket.to, count: bucket.count, quality: bucket.quality, unit, seriesId };
}
