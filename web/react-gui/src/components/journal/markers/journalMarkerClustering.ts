/**
 * Pure geometry for the journal marker lane: mapping an occurred timestamp to a
 * rendered x-position, and clustering markers whose rendered positions land
 * within a pixel-distance threshold of one another. No React, no fetching —
 * this is deliberately usable (and unit-testable) outside the component tree.
 */

export interface ClusterableMarker {
  entryUuid: string;
  activityCode: string;
  occurredAtMs: number;
}

export interface MarkerCluster<T extends ClusterableMarker> {
  id: string;
  xPx: number;
  markers: T[];
}

export const DEFAULT_CLUSTER_DISTANCE_PX = 48;

/** Maps `occurredAtMs` to a 0..widthPx x-position, clamped to the window bounds. */
export function markerXPx(occurredAtMs: number, fromMs: number, toMs: number, widthPx: number): number {
  const spanMs = toMs - fromMs;
  if (!Number.isFinite(occurredAtMs) || !Number.isFinite(fromMs) || !Number.isFinite(toMs) ||
      !Number.isFinite(widthPx) || spanMs <= 0 || widthPx <= 0) {
    return 0;
  }
  const ratio = (occurredAtMs - fromMs) / spanMs;
  return Math.min(Math.max(ratio, 0), 1) * widthPx;
}

function clusterMean<T extends ClusterableMarker>(members: T[], fromMs: number, toMs: number, widthPx: number): number {
  const sum = members.reduce((total, member) => total + markerXPx(member.occurredAtMs, fromMs, toMs, widthPx), 0);
  return sum / members.length;
}

/**
 * Groups markers whose rendered x-position lands within `distanceThresholdPx`
 * of the growing cluster's running centroid. Input order does not matter —
 * markers are sorted chronologically first so clusters read left-to-right.
 */
export function clusterMarkersByDistance<T extends ClusterableMarker>(
  markers: readonly T[],
  fromMs: number,
  toMs: number,
  widthPx: number,
  distanceThresholdPx: number = DEFAULT_CLUSTER_DISTANCE_PX,
): Array<MarkerCluster<T>> {
  const sorted = [...markers].sort((left, right) => left.occurredAtMs - right.occurredAtMs);
  const clusters: Array<MarkerCluster<T>> = [];

  for (const candidate of sorted) {
    const candidateX = markerXPx(candidate.occurredAtMs, fromMs, toMs, widthPx);
    const last = clusters[clusters.length - 1];

    if (last && Math.abs(candidateX - last.xPx) <= distanceThresholdPx) {
      last.markers.push(candidate);
      last.xPx = clusterMean(last.markers, fromMs, toMs, widthPx);
      continue;
    }

    clusters.push({ id: `cluster-${clusters.length}-${candidate.entryUuid}`, xPx: candidateX, markers: [candidate] });
  }

  return clusters;
}
