import { describe, expect, it } from 'vitest';
import { clusterMarkersByDistance, markerXPx } from '../journalMarkerClustering';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SEASON_MS = 180 * DAY_MS;

interface FixtureMarker {
  entryUuid: string;
  activityCode: string;
  occurredAtMs: number;
}

function marker(entryUuid: string, occurredAtMs: number, activityCode = 'irrigation'): FixtureMarker {
  return { entryUuid, activityCode, occurredAtMs };
}

describe('markerXPx', () => {
  it('maps the window start to 0px', () => {
    expect(markerXPx(0, 0, DAY_MS, 320)).toBe(0);
  });

  it('maps the window end to the full width', () => {
    expect(markerXPx(DAY_MS, 0, DAY_MS, 320)).toBe(320);
  });

  it('maps the midpoint to half the width', () => {
    expect(markerXPx(DAY_MS / 2, 0, DAY_MS, 320)).toBe(160);
  });

  it('clamps timestamps before the window to 0px', () => {
    expect(markerXPx(-HOUR_MS, 0, DAY_MS, 320)).toBe(0);
  });

  it('clamps timestamps after the window to the full width', () => {
    expect(markerXPx(DAY_MS + HOUR_MS, 0, DAY_MS, 320)).toBe(320);
  });

  it('returns 0 for a degenerate (zero-width) time window', () => {
    expect(markerXPx(500, 1000, 1000, 320)).toBe(0);
  });
});

describe('clusterMarkersByDistance', () => {
  it('returns an empty cluster list for zero markers', () => {
    expect(clusterMarkersByDistance([], 0, DAY_MS, 320)).toEqual([]);
  });

  it('places a single marker in its own cluster', () => {
    const markers = [marker('e1', DAY_MS / 2)];
    const clusters = clusterMarkersByDistance(markers, 0, DAY_MS, 320);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].markers).toEqual(markers);
  });

  it('keeps two markers separate when they render further apart than the distance threshold', () => {
    // 24h window at 320px: 1px ~= 270s. Six hours apart is nowhere close to the 48px threshold.
    const markers = [marker('e1', 0), marker('e2', 12 * HOUR_MS)];
    const clusters = clusterMarkersByDistance(markers, 0, DAY_MS, 320, 48);

    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.markers.length)).toEqual([1, 1]);
  });

  it('merges two markers into one cluster when they render within the distance threshold', () => {
    // 24h window at 320px => 13.33 px/hour. Two markers 1 hour apart render ~13px apart, well under 48px.
    const markers = [marker('e1', 10 * HOUR_MS), marker('e2', 11 * HOUR_MS)];
    const clusters = clusterMarkersByDistance(markers, 0, DAY_MS, 320, 48);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].markers).toHaveLength(2);
  });

  it('sorts markers chronologically before clustering regardless of input order', () => {
    const markers = [marker('later', 20 * HOUR_MS), marker('earlier', 1 * HOUR_MS)];
    const clusters = clusterMarkersByDistance(markers, 0, DAY_MS, 320, 48);

    expect(clusters).toHaveLength(2);
    expect(clusters[0].markers[0].entryUuid).toBe('earlier');
    expect(clusters[1].markers[0].entryUuid).toBe('later');
  });

  it('produces a count-labeled cluster with a stable id for 50 dense events', () => {
    const markers = Array.from({ length: 50 }, (_, i) => marker(`e${i}`, i * 60_000));
    const clusters = clusterMarkersByDistance(markers, 0, DAY_MS, 320, 48);

    expect(clusters.length).toBeGreaterThan(0);
    const totalClustered = clusters.reduce((sum, c) => sum + c.markers.length, 0);
    expect(totalClustered).toBe(50);
    expect(clusters.every((c) => typeof c.id === 'string' && c.id.length > 0)).toBe(true);
  });

  it('handles 500 events spread across a season window without losing any marker', () => {
    const markers = Array.from({ length: 500 }, (_, i) => marker(`e${i}`, (i / 500) * SEASON_MS));
    const clusters = clusterMarkersByDistance(markers, 0, SEASON_MS, 320, 48);

    const totalClustered = clusters.reduce((sum, c) => sum + c.markers.length, 0);
    expect(totalClustered).toBe(500);
    // 320px of room and a 48px minimum gap between cluster centroids caps cluster count well under 500.
    expect(clusters.length).toBeLessThan(50);
  });

  it('reports a cluster centroid x-position as the mean of its members', () => {
    const markers = [marker('e1', 10 * HOUR_MS), marker('e2', 10 * HOUR_MS + 5000)];
    const clusters = clusterMarkersByDistance(markers, 0, DAY_MS, 320, 48);

    expect(clusters).toHaveLength(1);
    const expectedX = markerXPx(10 * HOUR_MS + 2500, 0, DAY_MS, 320);
    expect(clusters[0].xPx).toBeCloseTo(expectedX, 1);
  });
});
