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

/**
 * Left/right padding (in px) between the lane's full width and the plotted
 * time domain, mirroring a chart's plot-area insets (margin + value-axis
 * width). Defaults to no inset so callers that render edge-to-edge (and
 * every pre-existing test) are unaffected.
 */
export interface PlotAreaInsets {
  left: number;
  right: number;
}

const NO_INSETS: PlotAreaInsets = { left: 0, right: 0 };

export const DEFAULT_CLUSTER_DISTANCE_PX = 48;

/**
 * Maps `occurredAtMs` to an x-position, clamped to the window bounds.
 * Without `insets`, the domain spans the full `[0, widthPx]` lane width. With
 * `insets`, the domain is mapped across the narrower plot area
 * `[insets.left, widthPx - insets.right]` instead — matching a chart that
 * insets its plot area within the same overall width (see `chartAxis.ts`).
 */
export function markerXPx(
  occurredAtMs: number,
  fromMs: number,
  toMs: number,
  widthPx: number,
  insets: PlotAreaInsets = NO_INSETS,
): number {
  const spanMs = toMs - fromMs;
  const { left, right } = insets;
  const plotWidthPx = widthPx - left - right;
  if (!Number.isFinite(occurredAtMs) || !Number.isFinite(fromMs) || !Number.isFinite(toMs) ||
      !Number.isFinite(widthPx) || !Number.isFinite(left) || !Number.isFinite(right) ||
      spanMs <= 0 || widthPx <= 0 || plotWidthPx <= 0) {
    return 0;
  }
  const ratio = (occurredAtMs - fromMs) / spanMs;
  return left + Math.min(Math.max(ratio, 0), 1) * plotWidthPx;
}

function clusterMean<T extends ClusterableMarker>(
  members: T[],
  fromMs: number,
  toMs: number,
  widthPx: number,
  insets: PlotAreaInsets,
): number {
  const sum = members.reduce((total, member) => total + markerXPx(member.occurredAtMs, fromMs, toMs, widthPx, insets), 0);
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
  insets: PlotAreaInsets = NO_INSETS,
): Array<MarkerCluster<T>> {
  const sorted = [...markers].sort((left, right) => left.occurredAtMs - right.occurredAtMs);
  const clusters: Array<MarkerCluster<T>> = [];

  for (const candidate of sorted) {
    const candidateX = markerXPx(candidate.occurredAtMs, fromMs, toMs, widthPx, insets);
    const last = clusters[clusters.length - 1];

    if (last && Math.abs(candidateX - last.xPx) <= distanceThresholdPx) {
      last.markers.push(candidate);
      last.xPx = clusterMean(last.markers, fromMs, toMs, widthPx, insets);
      continue;
    }

    clusters.push({ id: `cluster-${clusters.length}-${candidate.entryUuid}`, xPx: candidateX, markers: [candidate] });
  }

  return clusters;
}
